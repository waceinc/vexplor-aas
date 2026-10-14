/**
 * In-memory reference implementation of the integration store port (docs/design/integration-v1.md §3.3).
 *
 * One implementation, three uses: `InMemoryStore` composes it, `FolderStore` composes it and persists its
 * `snapshot()`, and the work packages test against it before the store port is extended. A second in-memory copy of
 * this logic would drift from this one, so do not write one — compose this class.
 *
 * Package facts (existence and owner) come from the outside through `ownerOf`, because this class does not hold
 * packages. Model events are recorded by the owning store through `recordModelEvent` (the owner is known there).
 *
 * Important: every value going in or out is deep-copied. Callers keep references to what they pass and receive; a
 *    shared object would let a later mutation rewrite an already recorded event or config.
 */
import { randomUUID } from 'node:crypto';

import { typesMatch } from '@aas/core';

import { actorFields } from './actor.js';
import {
  ExternalRefConflictError,
  externalRefSubjectString,
  type DeliveryRecord,
  type DeliveryResult,
  type DeliveryStats,
  type DeliveryStatus,
  type EventPage,
  type EventQuery,
  type ExternalRefClaim,
  type ExternalRefsDoc,
  type IntegrationStore,
  type NewEvent,
  type NewSubscription,
  type StoredEvent,
  type SubscriptionPatch,
  type SubscriptionRecord,
  type SubscriptionSecrets,
  type Versioned,
} from './integration-types.js';
import { ConflictError, NotFoundError, type PackageScope, type PageQuery, type PageResult } from './types.js';

/** owner string = exists with that owner; undefined = exists without owner; null = no such package */
export type OwnerLookup = (packageId: string) => string | undefined | null;

export interface MemoryIntegrationLogOptions {
  /** Event cap — the oldest rows are dropped beyond it and `oldestSeq` advances. Default 100 000 */
  maxEvents?: number;
  /** Clock for `recordedAt`, `createdAt`, config `updatedAt`. Default: the system clock */
  now?: () => string;
  /** Random id source for subscriptions. Default: crypto.randomUUID */
  newId?: () => string;
}

export const AUDIT_EVENT_TYPE = 'kr.vexplor.aas.integration.audit.v1';
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

interface RuntimeRow {
  value: unknown;
  packageId?: string;
  updatedAt: string;
}

/** JSON-transferable state — FolderStore writes it to disk, so it must survive JSON.stringify / JSON.parse */
export interface MemoryIntegrationSnapshot {
  version: 1;
  lastSeq: number;
  events: StoredEvent[];
  subscriptions: SubscriptionRecord[];
  secrets: Record<string, SubscriptionSecrets>;
  deliveries: DeliveryRecord[];
  nextDeliveryId: number;
  serverConfig?: Versioned<unknown>;
  packageConfigs: Record<string, Versioned<unknown>>;
  refs: Record<string, Versioned<ExternalRefsDoc>>;
  state: Record<string, RuntimeRow>;
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
const ms = (iso: string): number => Date.parse(iso);

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)));
}

/** Applies a patch where a present key with `undefined` deletes the field */
function applyPatch<T extends object>(target: T, patch: object): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (target as Record<string, unknown>)[key];
    else (target as Record<string, unknown>)[key] = copy(value);
  }
}

export class MemoryIntegrationLog implements IntegrationStore {
  private events: StoredEvent[] = [];
  private eventIds = new Set<string>();
  private lastSeq = 0;
  private subscriptions = new Map<string, SubscriptionRecord>();
  private secrets = new Map<string, SubscriptionSecrets>();
  private deliveries = new Map<string, DeliveryRecord>();
  private nextDeliveryId = 1;
  private serverConfig: Versioned<unknown> | undefined;
  private packageConfigs = new Map<string, Versioned<unknown>>();
  private refs = new Map<string, Versioned<ExternalRefsDoc>>();
  /** `system|type|id` → claim */
  private refKeys = new Map<string, ExternalRefClaim>();
  private state = new Map<string, RuntimeRow>();
  private readonly maxEvents: number;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly ownerOf: OwnerLookup,
    options: MemoryIntegrationLogOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  // ── events ──────────────────────────────────────────────────────────────────

  /** Records a model event with an owner the calling store already knows. Returns undefined for a duplicate id */
  recordModelEvent(event: NewEvent & { owner?: string }): StoredEvent | undefined {
    const { owner, ...rest } = event;
    return this.insert(rest, owner);
  }

  async appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    const inserted: StoredEvent[] = [];
    for (const event of events) {
      const owner = event.packageId === undefined ? undefined : (this.ownerOf(event.packageId) ?? undefined);
      const row = this.insert(event, owner);
      if (row) inserted.push(row);
    }
    return inserted;
  }

  private insert(event: NewEvent, owner: string | undefined): StoredEvent | undefined {
    if (this.eventIds.has(event.id)) return undefined;
    const row: StoredEvent = { ...copy(event), seq: ++this.lastSeq, recordedAt: this.now() };
    if (owner !== undefined) row.owner = owner;
    this.events.push(row);
    this.eventIds.add(row.id);
    while (this.events.length > this.maxEvents) {
      const dropped = this.events.shift()!;
      this.eventIds.delete(dropped.id);
    }
    return copy(row);
  }

  async readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage> {
    const limit = clampLimit(query.limit, 200);
    const items: StoredEvent[] = [];
    for (const row of this.events) {
      if (items.length >= limit) break;
      if (row.seq <= query.after) continue;
      if (!query.includeAudit && row.type === AUDIT_EVENT_TYPE) continue;
      if (query.packageId !== undefined && row.packageId !== query.packageId) continue;
      if (scope !== undefined && row.owner !== undefined && row.owner !== scope.owner) continue;
      if (!typesMatch(query.types, row.type)) continue;
      items.push(copy(row));
    }
    return {
      items,
      oldestSeq: this.events[0]?.seq ?? null,
      lastSeq: this.events[this.events.length - 1]?.seq ?? 0,
    };
  }

  async pruneEvents(before: string): Promise<number> {
    const cut = ms(before);
    const kept = this.events.filter((row) => ms(row.recordedAt) >= cut);
    const removed = this.events.length - kept.length;
    for (const row of this.events) if (ms(row.recordedAt) < cut) this.eventIds.delete(row.id);
    this.events = kept;
    return removed;
  }

  // ── subscriptions ───────────────────────────────────────────────────────────

  async listSubscriptions(): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => copy(record));
  }

  async getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined> {
    const record = this.subscriptions.get(id);
    const secrets = this.secrets.get(id);
    return record && secrets ? { ...copy(record), secrets: copy(secrets) } : undefined;
  }

  async createSubscription(input: NewSubscription): Promise<SubscriptionRecord> {
    const { secrets, ...fields } = copy(input);
    const at = this.now();
    const record: SubscriptionRecord = { ...fields, id: `sub_${this.newId().replace(/-/g, '')}`, consecutiveDead: 0, createdAt: at, updatedAt: at };
    this.subscriptions.set(record.id, record);
    this.secrets.set(record.id, secrets);
    return copy(record);
  }

  async updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined> {
    const record = this.subscriptions.get(id);
    if (!record) return undefined;
    const { secrets, ...fields } = patch;
    applyPatch(record, fields);
    if (secrets !== undefined) this.secrets.set(id, copy(secrets));
    record.updatedAt = this.now();
    return copy(record);
  }

  async deleteSubscription(id: string): Promise<boolean> {
    if (!this.subscriptions.delete(id)) return false;
    this.secrets.delete(id);
    for (const [key, row] of this.deliveries) if (row.subscriptionId === id) this.deliveries.delete(key);
    return true;
  }

  // ── deliveries ──────────────────────────────────────────────────────────────

  async enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number> {
    const existing = new Set([...this.deliveries.values()].map((row) => `${row.subscriptionId}|${row.eventSeq}`));
    let inserted = 0;
    for (const row of rows) {
      const key = `${row.subscriptionId}|${row.eventSeq}`;
      if (existing.has(key) || !this.subscriptions.has(row.subscriptionId)) continue;
      const id = String(this.nextDeliveryId++);
      this.deliveries.set(id, {
        id,
        subscriptionId: row.subscriptionId,
        eventSeq: row.eventSeq,
        eventId: row.eventId,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
      existing.add(key);
      inserted += 1;
    }
    return inserted;
  }

  async claimDeliveries(now: string, limit: number, leaseMs: number): Promise<DeliveryRecord[]> {
    const at = ms(now);
    const due = [...this.deliveries.values()]
      .filter((row) =>
        (row.status === 'pending' && ms(row.nextAttemptAt) <= at) ||
        (row.status === 'in-flight' && row.leaseUntil !== undefined && ms(row.leaseUntil) < at))
      .sort((a, b) => ms(a.nextAttemptAt) - ms(b.nextAttemptAt) || Number(a.id) - Number(b.id))
      .slice(0, Math.max(0, limit));
    const leaseUntil = new Date(at + leaseMs).toISOString();
    for (const row of due) {
      row.status = 'in-flight';
      row.leaseUntil = leaseUntil;
      row.attempts += 1;
      row.updatedAt = now;
    }
    return due.map((row) => copy(row));
  }

  async completeDelivery(id: string, result: DeliveryResult): Promise<void> {
    const row = this.deliveries.get(id);
    if (!row) return;
    row.status = result.outcome === 'retry' ? 'pending' : result.outcome;
    if (result.outcome === 'retry') row.nextAttemptAt = result.nextAttemptAt ?? result.at;
    delete row.leaseUntil;
    // "last" describes the attempt that just finished — fields it did not produce are cleared, not kept from before
    const last: Pick<DeliveryRecord, 'lastStatusCode' | 'lastError' | 'lastDurationMs' | 'lastAddress'> = {
      lastStatusCode: result.statusCode,
      lastError: result.error,
      lastDurationMs: result.durationMs,
      lastAddress: result.address,
    };
    applyPatch(row, last);
    row.updatedAt = result.at;
  }

  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    return copy(this.deliveries.get(id));
  }

  async listDeliveries(subscriptionId: string, query: { status?: DeliveryStatus } & PageQuery = {}): Promise<PageResult<DeliveryRecord>> {
    const all = [...this.deliveries.values()]
      .filter((row) => row.subscriptionId === subscriptionId && (query.status === undefined || row.status === query.status))
      .sort((a, b) => Number(b.id) - Number(a.id));
    const limit = clampLimit(query.limit, DEFAULT_PAGE);
    const start = query.cursor === undefined ? 0 : all.findIndex((row) => Number(row.id) < Number(query.cursor));
    const slice = start < 0 ? [] : all.slice(start, start + limit);
    const result: PageResult<DeliveryRecord> = { items: slice.map((row) => copy(row)) };
    const last = slice[slice.length - 1];
    if (last !== undefined && start + slice.length < all.length) result.cursor = last.id;
    return result;
  }

  async redeliver(id: string, now: string): Promise<boolean> {
    const row = this.deliveries.get(id);
    if (!row) return false;
    row.status = 'pending';
    row.nextAttemptAt = now;
    delete row.leaseUntil;
    row.updatedAt = now;
    return true;
  }

  async deliveryStats(): Promise<DeliveryStats[]> {
    const stats = new Map<string, DeliveryStats>();
    for (const record of await this.listSubscriptions()) {
      stats.set(record.id, { subscriptionId: record.id, pending: 0, inFlight: 0, dead: 0, succeeded: 0 });
    }
    for (const row of this.deliveries.values()) {
      const entry = stats.get(row.subscriptionId);
      if (!entry) continue;
      if (row.status === 'pending') entry.pending += 1;
      else if (row.status === 'in-flight') entry.inFlight += 1;
      else if (row.status === 'dead') entry.dead += 1;
      else entry.succeeded += 1;
      if ((row.status === 'pending' || row.status === 'in-flight') && (entry.oldestPendingAt === undefined || ms(row.createdAt) < ms(entry.oldestPendingAt))) {
        entry.oldestPendingAt = row.createdAt;
      }
    }
    return [...stats.values()];
  }

  async pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number> {
    const okCut = ms(succeededBefore);
    const deadCut = ms(deadBefore);
    let removed = 0;
    for (const [key, row] of this.deliveries) {
      const at = ms(row.updatedAt);
      if ((row.status === 'succeeded' && at < okCut) || (row.status === 'dead' && at < deadCut)) {
        this.deliveries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // ── configuration ───────────────────────────────────────────────────────────

  async getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined> {
    return copy(this.serverConfig);
  }

  async putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    this.serverConfig = this.nextVersion(this.serverConfig, value, expectedRevision);
    return copy(this.serverConfig);
  }

  async getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined> {
    return copy(this.packageConfigs.get(packageId));
  }

  async putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    this.requirePackage(packageId);
    const next = this.nextVersion(this.packageConfigs.get(packageId), value, expectedRevision);
    this.packageConfigs.set(packageId, next);
    return copy(next);
  }

  // ── external references ─────────────────────────────────────────────────────

  async getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined> {
    return copy(this.refs.get(packageId));
  }

  async putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>> {
    this.requirePackage(packageId);
    const current = this.refs.get(packageId);
    // Revision first: a stale writer must re-read before it learns anything about other packages' claims
    const next = this.nextVersion(current, doc, expectedRevision);

    const claims = new Map<string, ExternalRefClaim>();
    const conflicts: ExternalRefClaim[] = [];
    for (const entry of doc.subjects) {
      const subject = externalRefSubjectString(entry.subject);
      for (const ref of entry.refs) {
        const key = refKey(ref.system, ref.type, ref.id);
        const claim: ExternalRefClaim = { system: ref.system, type: ref.type, id: ref.id, packageId, subject };
        const inDoc = claims.get(key);
        if (inDoc !== undefined) {
          if (inDoc.subject !== subject) conflicts.push(inDoc, claim);
          continue;
        }
        const held = this.refKeys.get(key);
        if (held !== undefined && held.packageId !== packageId) conflicts.push(held, claim);
        claims.set(key, claim);
      }
    }
    if (conflicts.length > 0) throw new ExternalRefConflictError(copy(conflicts));

    for (const [key, claim] of this.refKeys) if (claim.packageId === packageId) this.refKeys.delete(key);
    for (const [key, claim] of claims) this.refKeys.set(key, claim);
    this.refs.set(packageId, next as Versioned<ExternalRefsDoc>);
    return copy(next as Versioned<ExternalRefsDoc>);
  }

  async findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]> {
    const claim = this.refKeys.get(refKey(system, type, id));
    return claim ? [{ packageId: claim.packageId, subject: claim.subject }] : [];
  }

  async listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]> {
    return [...this.refs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([packageId, refs]) => ({ packageId, refs: copy(refs) }));
  }

  // ── runtime state ───────────────────────────────────────────────────────────

  async getRuntimeState(key: string): Promise<unknown | undefined> {
    return copy(this.state.get(key)?.value);
  }

  async putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> {
    if (packageId !== undefined) this.requirePackage(packageId);
    const row: RuntimeRow = { value: copy(value), updatedAt: this.now() };
    if (packageId !== undefined) row.packageId = packageId;
    this.state.set(key, row);
  }

  // ── package lifecycle and persistence ───────────────────────────────────────

  /** Called by the owning store when a package is deleted — config, refs (and their keys) and runtime state go. Events stay */
  forgetPackage(packageId: string): void {
    this.packageConfigs.delete(packageId);
    this.refs.delete(packageId);
    for (const [key, claim] of this.refKeys) if (claim.packageId === packageId) this.refKeys.delete(key);
    for (const [key, row] of this.state) if (row.packageId === packageId) this.state.delete(key);
  }

  snapshot(): MemoryIntegrationSnapshot {
    const snapshot: MemoryIntegrationSnapshot = {
      version: 1,
      lastSeq: this.lastSeq,
      events: copy(this.events),
      subscriptions: copy([...this.subscriptions.values()]),
      secrets: copy(Object.fromEntries(this.secrets)),
      deliveries: copy([...this.deliveries.values()]),
      nextDeliveryId: this.nextDeliveryId,
      packageConfigs: copy(Object.fromEntries(this.packageConfigs)),
      refs: copy(Object.fromEntries(this.refs)),
      state: copy(Object.fromEntries(this.state)),
    };
    if (this.serverConfig !== undefined) snapshot.serverConfig = copy(this.serverConfig);
    return snapshot;
  }

  /** Replaces everything with a snapshot. The ref key index is rebuilt from the docs, so it cannot disagree with them */
  restore(snapshot: MemoryIntegrationSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`Unsupported integration snapshot version: ${String(snapshot.version)}`);
    const data = copy(snapshot);
    this.events = [...data.events].sort((a, b) => a.seq - b.seq);
    this.eventIds = new Set(this.events.map((row) => row.id));
    this.lastSeq = Math.max(data.lastSeq, this.events[this.events.length - 1]?.seq ?? 0);
    this.subscriptions = new Map(data.subscriptions.map((record) => [record.id, record]));
    this.secrets = new Map(Object.entries(data.secrets));
    this.deliveries = new Map(data.deliveries.map((row) => [row.id, row]));
    this.nextDeliveryId = Math.max(data.nextDeliveryId, ...data.deliveries.map((row) => Number(row.id) + 1), 1);
    this.serverConfig = data.serverConfig;
    this.packageConfigs = new Map(Object.entries(data.packageConfigs));
    this.refs = new Map(Object.entries(data.refs));
    this.refKeys = new Map();
    for (const [packageId, versioned] of this.refs) {
      for (const entry of versioned.value.subjects) {
        const subject = externalRefSubjectString(entry.subject);
        for (const ref of entry.refs) this.refKeys.set(refKey(ref.system, ref.type, ref.id), { system: ref.system, type: ref.type, id: ref.id, packageId, subject });
      }
    }
    this.state = new Map(Object.entries(data.state));
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private requirePackage(packageId: string): void {
    if (this.ownerOf(packageId) === null) throw new NotFoundError(packageId);
  }

  /** Revision rule shared by configs and refs: first put = 1, each put + 1, mismatch → ConflictError ("never saved" = 0) */
  private nextVersion(current: Versioned<unknown> | undefined, value: unknown, expectedRevision: number | undefined): Versioned<unknown> {
    const actual = current?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== actual) throw new ConflictError(expectedRevision, actual);
    return { value: copy(value), revision: actual + 1, updatedAt: this.now(), ...actorFields() };
  }
}

/** JSON array form — unambiguous whatever characters the three parts contain */
function refKey(system: string, type: string, id: string): string {
  return JSON.stringify([system, type, id]);
}
