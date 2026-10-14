/**
 * Folder store — the integration files (docs/design/integration-v1.md §3.5).
 *
 * The folder store keeps the integration state in the same `MemoryIntegrationLog` the memory store uses and writes it
 * to four files at the data-folder root (root files are never mistaken for packages — `init()` scans directories only):
 *
 *   events.jsonl             one StoredEvent per line, or {"void":"<id>"}     append + fdatasync
 *   deliveries.jsonl         one full DeliveryRecord per line, last line wins  append; rewritten at init and on prune
 *   integration.json         subscriptions, secrets, configs, refs, counters   temp + rename, serialized
 *   integration-state.json   runtime state (detector, projector, cursors)      temp + rename, at most once per second
 *
 * Crash protocol for model events: the mutating method changes memory (and records the event there), then the event
 * line is appended and synced, **then** the model file is written. A crash between the two leaves an event for a change
 * that never reached disk; `load()` finds it by comparing the event's package revision with the loaded package and
 * voids it, so it is never returned again.
 *
 * Important: the guarantees assume a local disk. Network file systems (SMB, NFS, a NAS share) have weaker rename and
 *    fsync semantics — documented as a limitation, not tested.
 * Important: `seq` must never be reused, not even the seq of a voided event — a pull-feed consumer that saw it before
 *    the crash keeps it as its cursor and would silently skip a new event with the same number. So the highest seq
 *    ever written is carried in integration.json across compactions.
 */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EVENT_TYPES, fill, tr } from '@aas/core';

import type { MemoryIntegrationLog, MemoryIntegrationSnapshot } from './integration-memory.js';
import type {
  DeliveryRecord,
  ExternalRefsDoc,
  StoredEvent,
  SubscriptionRecord,
  SubscriptionSecrets,
  Versioned,
} from './integration-types.js';

export const EVENTS_FILE = 'events.jsonl';
export const DELIVERIES_FILE = 'deliveries.jsonl';
export const INTEGRATION_FILE = 'integration.json';
export const INTEGRATION_STATE_FILE = 'integration-state.json';

/** Runtime state is rewritten at most this often — detector and projector cursors move every cycle */
const STATE_WRITE_INTERVAL_MS = 1000;
const PAGE = 1000;

export type RenameFn = (from: string, to: string) => Promise<void>;

/** What a package looks like on disk after loading — undefined = the package does not exist */
export type LoadedRevision = (packageId: string) => number | undefined;

type StateRows = MemoryIntegrationSnapshot['state'];

interface IntegrationFile {
  version: 1;
  /** Highest seq ever assigned, voided events included */
  lastSeq: number;
  nextDeliveryId: number;
  subscriptions: SubscriptionRecord[];
  secrets: Record<string, SubscriptionSecrets>;
  serverConfig?: Versioned<unknown>;
  packageConfigs: Record<string, Versioned<unknown>>;
  refs: Record<string, Versioned<ExternalRefsDoc>>;
}

interface StateFile {
  version: 1;
  state: StateRows;
}

/** Runs async jobs one after another; a failed job does not block the next */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const MODEL_PREFIX = 'kr.vexplor.aas.model.';

/**
 * Which model events describe a change that never reached disk. Pure, so the crash cases are testable on their own.
 *
 * Per package, in seq order:
 * - `model.package.deleted` is void when the package still exists and was not created again afterwards (the
 *   directory removal did not happen).
 * - Every other model event after the last valid deletion is void when the package is missing (import or edit
 *   never written) or its `packageRevision` is above the loaded revision (edit never written).
 * Events before the last valid deletion belong to an earlier life of the package id and stay.
 */
export function voidedModelEvents(events: readonly StoredEvent[], revisionOf: LoadedRevision): Set<string> {
  const byPackage = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (event.packageId === undefined || !event.type.startsWith(MODEL_PREFIX)) continue;
    const list = byPackage.get(event.packageId) ?? [];
    list.push(event);
    byPackage.set(event.packageId, list);
  }
  const voided = new Set<string>();
  for (const [packageId, list] of byPackage) {
    list.sort((a, b) => a.seq - b.seq);
    const revision = revisionOf(packageId);
    let lastDeletion = 0;
    for (const event of list) {
      if (event.type !== EVENT_TYPES.modelPackageDeleted) continue;
      const createdAgain = list.some((later) => later.seq > event.seq && later.type === EVENT_TYPES.modelPackageCreated);
      if (revision !== undefined && !createdAgain) voided.add(event.id);
      else lastDeletion = event.seq;
    }
    for (const event of list) {
      if (event.type === EVENT_TYPES.modelPackageDeleted || event.seq < lastDeletion) continue;
      if (revision === undefined || (event.packageRevision !== undefined && event.packageRevision > revision)) voided.add(event.id);
    }
  }
  return voided;
}

/** Lines of a JSONL file; a torn last line (power loss mid-append) is skipped, like values.jsonl */
async function readLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Only the torn line is lost
    }
  }
  return out;
}

/** A JSON file that must be readable when it exists — a silent empty start would drop subscriptions and their secrets */
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    // Startup error for the operator — the language comes from AAS_LANG (apps/api/src/lang.ts bootLang)
    throw new Error(fill(tr('{0}을(를) 읽지 못했습니다 — 손으로 고치거나 지운 뒤 다시 띄우십시오: {1}'), { 0: path, 1: String(error) }));
  }
}

export class FolderIntegrationFiles {
  /** Rows recorded in memory but not yet appended to events.jsonl */
  private pending: StoredEvent[] = [];
  private highestSeq = 0;
  private highestDeliveryId = 0;
  /** Mirror of runtime state metadata — the log only hands out values, the file needs owner package and time too */
  private stateRows = new Map<string, { packageId?: string; updatedAt: string }>();
  private stateTimer: NodeJS.Timeout | undefined;
  private lastStateWrite = 0;
  private readonly eventWrites = new Serial();
  private readonly configWrites = new Serial();
  private readonly deliveryWrites = new Serial();
  private readonly stateWrites = new Serial();

  constructor(
    private readonly dir: string,
    private readonly log: MemoryIntegrationLog,
    private readonly rename: RenameFn,
    private readonly packageIds: () => string[],
    private readonly now: () => string,
  ) {}

  private path(name: string): string {
    return join(this.dir, name);
  }

  private async replaceFile(name: string, text: string): Promise<void> {
    const target = this.path(name);
    const temp = `${target}.tmp`;
    await writeFile(temp, text, 'utf8');
    await this.rename(temp, target);
  }

  private async appendSynced(name: string, text: string): Promise<void> {
    const handle = await open(this.path(name), 'a');
    try {
      await handle.appendFile(text, 'utf8');
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  // ── loading ─────────────────────────────────────────────────────────────────

  /** Reads the four files into the log. Called by FolderStore.init() after the packages are loaded */
  async load(revisionOf: LoadedRevision): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const config = await readJson<IntegrationFile>(this.path(INTEGRATION_FILE));
    const stateFile = await readJson<StateFile>(this.path(INTEGRATION_STATE_FILE));

    const events: StoredEvent[] = [];
    const voidedBefore = new Set<string>();
    let lineCount = 0;
    for (const line of await readLines(this.path(EVENTS_FILE))) {
      lineCount += 1;
      const record = line as Partial<StoredEvent> & { void?: string };
      if (typeof record.void === 'string') voidedBefore.add(record.void);
      else if (typeof record.seq === 'number' && typeof record.id === 'string') events.push(record as StoredEvent);
    }
    // Every seq ever written counts, voided ones included (see the file comment)
    // reduce, not Math.max(...spread): a long log would exceed the engine's argument limit
    this.highestSeq = events.reduce((max, event) => Math.max(max, event.seq), config?.lastSeq ?? 0);
    const alive = events.filter((event) => !voidedBefore.has(event.id)).sort((a, b) => a.seq - b.seq);
    const newlyVoided = voidedModelEvents(alive, revisionOf);
    const kept = alive.filter((event) => !newlyVoided.has(event.id));

    const subscriptions = config?.subscriptions ?? [];
    const known = new Set(subscriptions.map((record) => record.id));
    const latest = new Map<string, DeliveryRecord>();
    for (const line of await readLines(this.path(DELIVERIES_FILE))) {
      const row = line as DeliveryRecord;
      if (typeof row.id === 'string' && known.has(row.subscriptionId)) latest.set(row.id, row);
    }
    const deliveries = [...latest.values()].sort((a, b) => Number(a.id) - Number(b.id));
    this.highestDeliveryId = deliveries.reduce((max, row) => Math.max(max, Number(row.id)), Math.max(0, (config?.nextDeliveryId ?? 1) - 1));

    // Rows of packages that no longer exist (a crash after the directory removal, before integration.json) are dropped
    const exists = (packageId: string): boolean => revisionOf(packageId) !== undefined;
    const onlyExisting = <T>(rows: Record<string, T> | undefined): Record<string, T> =>
      Object.fromEntries(Object.entries(rows ?? {}).filter(([packageId]) => exists(packageId)));
    const state: StateRows = Object.fromEntries(
      Object.entries(stateFile?.state ?? {}).filter(([, row]) => row.packageId === undefined || exists(row.packageId)),
    );
    for (const [key, row] of Object.entries(state)) {
      this.stateRows.set(key, row.packageId === undefined ? { updatedAt: row.updatedAt } : { packageId: row.packageId, updatedAt: row.updatedAt });
    }

    const snapshot: MemoryIntegrationSnapshot = {
      version: 1,
      lastSeq: this.highestSeq,
      events: kept,
      subscriptions,
      secrets: config?.secrets ?? {},
      deliveries,
      nextDeliveryId: this.highestDeliveryId + 1,
      packageConfigs: onlyExisting(config?.packageConfigs),
      refs: onlyExisting(config?.refs),
      state,
    };
    if (config?.serverConfig !== undefined) snapshot.serverConfig = config.serverConfig;
    this.log.restore(snapshot);

    if (newlyVoided.size > 0) {
      await this.appendSynced(EVENTS_FILE, [...newlyVoided].map((id) => JSON.stringify({ void: id })).join('\n') + '\n');
    }
    await this.compactDeliveries();
    // Rewrite the event file only when most of it is garbage (voided, torn or beyond the memory cap) — it can be large
    if (lineCount + newlyVoided.size > 2 * kept.length + 100) await this.compactEvents();
  }

  // ── events ──────────────────────────────────────────────────────────────────

  /** Called synchronously right after the log recorded a row */
  queueEvent(row: StoredEvent): void {
    this.pending.push(row);
    this.highestSeq = Math.max(this.highestSeq, row.seq);
  }

  /** Appends every queued row and syncs the file. Must complete before the model file of the change is written */
  flushEvents(): Promise<void> {
    return this.eventWrites.run(async () => {
      if (this.pending.length === 0) return;
      const rows = this.pending.splice(0);
      await this.appendSynced(EVENTS_FILE, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    });
  }

  /** Rewrites events.jsonl from what the log still holds (after a prune). integration.json first, for lastSeq */
  async compactEvents(): Promise<void> {
    await this.writeConfig();
    await this.eventWrites.run(async () => {
      // Queued rows are in the log already, so the rewrite includes them — drop the queue or they would be doubled
      this.pending = [];
      const lines: string[] = [];
      let after = 0;
      for (;;) {
        const page = await this.log.readEvents({ after, limit: PAGE, includeAudit: true });
        for (const row of page.items) lines.push(JSON.stringify(row));
        if (page.items.length < PAGE) break;
        after = page.items[page.items.length - 1]!.seq;
      }
      await this.replaceFile(EVENTS_FILE, lines.length === 0 ? '' : lines.join('\n') + '\n');
    });
  }

  // ── integration.json ────────────────────────────────────────────────────────

  writeConfig(): Promise<void> {
    return this.configWrites.run(async () => {
      // Read at write time, inside the queue — a later write always carries newer content
      const subscriptions = await this.log.listSubscriptions();
      const secrets: Record<string, SubscriptionSecrets> = {};
      for (const record of subscriptions) {
        const full = await this.log.getSubscription(record.id);
        if (full) secrets[record.id] = full.secrets;
      }
      const packageConfigs: Record<string, Versioned<unknown>> = {};
      for (const packageId of this.packageIds()) {
        const config = await this.log.getPackageIntegrationConfig(packageId);
        if (config) packageConfigs[packageId] = config;
      }
      const refs = Object.fromEntries((await this.log.listExternalRefs()).map((entry) => [entry.packageId, entry.refs]));
      const file: IntegrationFile = {
        version: 1,
        lastSeq: this.highestSeq,
        nextDeliveryId: this.highestDeliveryId + 1,
        subscriptions,
        secrets,
        packageConfigs,
        refs,
      };
      const serverConfig = await this.log.getServerIntegrationConfig();
      if (serverConfig !== undefined) file.serverConfig = serverConfig;
      await this.replaceFile(INTEGRATION_FILE, JSON.stringify(file));
    });
  }

  // ── deliveries.jsonl ────────────────────────────────────────────────────────

  /** Appends the current form of the given rows */
  appendDeliveries(rows: readonly DeliveryRecord[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    for (const row of rows) this.highestDeliveryId = Math.max(this.highestDeliveryId, Number(row.id));
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    return this.deliveryWrites.run(async () => {
      await mkdir(this.dir, { recursive: true });
      const handle = await open(this.path(DELIVERIES_FILE), 'a');
      try {
        await handle.appendFile(text, 'utf8');
      } finally {
        await handle.close();
      }
    });
  }

  /** After an enqueue: new rows have the ids right above the highest one seen (the log numbers them in sequence) */
  async appendNewDeliveries(): Promise<void> {
    const rows: DeliveryRecord[] = [];
    for (let id = this.highestDeliveryId + 1; ; id++) {
      const row = await this.log.getDelivery(String(id));
      if (!row) break;
      rows.push(row);
    }
    await this.appendDeliveries(rows);
  }

  /** Rewrites deliveries.jsonl with one line per live row — at init, after a prune and after a cascade */
  compactDeliveries(): Promise<void> {
    return this.deliveryWrites.run(async () => {
      const lines: string[] = [];
      for (const record of await this.log.listSubscriptions()) {
        const rows: DeliveryRecord[] = [];
        let cursor: string | undefined;
        do {
          const page = await this.log.listDeliveries(record.id, cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor });
          rows.push(...page.items);
          cursor = page.cursor;
        } while (cursor !== undefined);
        // listDeliveries is newest first; the file keeps creation order
        for (const row of rows.reverse()) lines.push(JSON.stringify(row));
      }
      await this.replaceFile(DELIVERIES_FILE, lines.length === 0 ? '' : lines.join('\n') + '\n');
    });
  }

  // ── integration-state.json ──────────────────────────────────────────────────

  /** Records a put; the file write is coalesced to at most one per STATE_WRITE_INTERVAL_MS */
  stateChanged(key: string, packageId?: string): void {
    this.stateRows.set(key, packageId === undefined ? { updatedAt: this.now() } : { packageId, updatedAt: this.now() });
    if (this.stateTimer !== undefined) return;
    const delay = Math.max(0, this.lastStateWrite + STATE_WRITE_INTERVAL_MS - Date.now());
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      // A failed background write is retried by the next put or flush; the cursors it holds are re-derivable
      this.writeState().catch(() => undefined);
    }, delay);
    this.stateTimer.unref();
  }

  private writeState(): Promise<void> {
    return this.stateWrites.run(async () => {
      this.lastStateWrite = Date.now();
      const state: StateRows = {};
      for (const [key, meta] of this.stateRows) {
        const value = await this.log.getRuntimeState(key);
        state[key] = meta.packageId === undefined ? { value, updatedAt: meta.updatedAt } : { value, packageId: meta.packageId, updatedAt: meta.updatedAt };
      }
      const file: StateFile = { version: 1, state };
      await this.replaceFile(INTEGRATION_STATE_FILE, JSON.stringify(file));
    });
  }

  /** Writes a pending runtime-state change now (shutdown, tests) */
  async flushState(): Promise<void> {
    if (this.stateTimer !== undefined) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
      await this.writeState();
    }
  }

  // ── package lifecycle ───────────────────────────────────────────────────────

  /** After a package deletion: its config, refs and runtime state are gone from the log — rewrite both files */
  async packageDeleted(packageId: string): Promise<void> {
    let stateTouched = false;
    for (const [key, meta] of this.stateRows) {
      if (meta.packageId === packageId) {
        this.stateRows.delete(key);
        stateTouched = true;
      }
    }
    await this.writeConfig();
    if (stateTouched) await this.writeState();
  }
}
