/**
 * The integration part of the store port — event log (outbox), subscriptions, deliveries, configuration, external
 * references and runtime state (docs/design/integration-v1.md §3.1).
 *
 * Why in the store and not beside it: model events must be written in the **same commit** as the model change
 * (outbox). An event log next to the store loses events on a crash between the two writes, or announces a change
 * that was rolled back. So every store implementation records model events inside its mutating methods.
 *
 * Contract details every implementation follows (the conformance suite checks them):
 * - Times are ISO 8601 strings in UTC (`toISOString()` form) and are compared as instants.
 * - A field that is not set is absent, never `undefined` or `null` — the folder store round-trips through JSON.
 * - Returned objects are copies; mutating them never changes the store.
 */
import { fill, tr } from '@aas/core';

import type { PackageScope, PageQuery, PageResult } from './types.js';

export interface StoredEvent {
  /** Assigned by the store, monotonic (not gap-free on PostgreSQL) */
  seq: number;
  /** UNIQUE; an append with an existing id is skipped */
  id: string;
  type: string;
  /** occurredAt (ISO) */
  time: string;
  /** Append time (ISO) — retention and settle horizon */
  recordedAt: string;
  packageId?: string;
  subject?: string;
  packageRevision?: number;
  /** Copied from the package at append time (workspace filtering). Absent = visible to every workspace */
  owner?: string;
  actorId?: string;
  actorName?: string;
  cause?: string;
  changeSetId?: string;
  data: Record<string, unknown>;
}

export interface NewEvent {
  id: string;
  type: string;
  time: string;
  packageId?: string;
  subject?: string;
  packageRevision?: number;
  actorId?: string;
  actorName?: string;
  cause?: string;
  changeSetId?: string;
  data: Record<string, unknown>;
}

export interface EventQuery {
  /** Exclusive */
  after: number;
  /** 1..1000 — implementations clamp into that range */
  limit: number;
  /** Exact, or a prefix ending in '*' (see `typeMatches` in @aas/core). Undefined or empty = every type */
  types?: readonly string[];
  packageId?: string;
  /** Default false — `integration.audit` rows are left out unless asked for */
  includeAudit?: boolean;
}

export interface EventPage {
  /** Ordered by seq, at most `limit` */
  items: StoredEvent[];
  /** Lowest retained seq of the whole log (unfiltered), null when the log is empty */
  oldestSeq: number | null;
  /** Highest retained seq of the whole log (unfiltered), 0 when the log is empty */
  lastSeq: number;
}

export type SubscriptionKind = 'webhook' | 'mqtt';

export interface SubscriptionOptions {
  topicPrefix?: string;
  retainState?: boolean;
}

export interface SubscriptionRecord {
  id: string;
  name: string;
  kind: SubscriptionKind;
  /** No userinfo ever (credentials are sealed separately) */
  url: string;
  types: string[];
  packageIds: string[];
  enabled: boolean;
  disabledReason?: string;
  options: SubscriptionOptions;
  /** Last 4 chars of the signing secret */
  secretHint: string;
  consecutiveDead: number;
  lastSuccessAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface SubscriptionSecrets {
  keyId: string;
  secretSealed: string;
  previousSealed?: string;
  previousUntil?: string;
  /** mqtt "user:password", sealed */
  credentialsSealed?: string;
}

export type NewSubscription = Omit<SubscriptionRecord, 'id' | 'createdAt' | 'updatedAt' | 'consecutiveDead' | 'lastSuccessAt'> & {
  secrets: SubscriptionSecrets;
};

/**
 * A key present with the value `undefined` removes that optional field (e.g. `{ enabled: true, disabledReason: undefined }`
 * clears the reason). `secrets`, when given, replaces the whole secrets record.
 */
export type SubscriptionPatch = Partial<
  Pick<SubscriptionRecord, 'name' | 'url' | 'types' | 'packageIds' | 'enabled' | 'disabledReason' | 'options' | 'secretHint' | 'consecutiveDead' | 'lastSuccessAt'>
> & { secrets?: SubscriptionSecrets };

export type DeliveryStatus = 'pending' | 'in-flight' | 'succeeded' | 'dead';

export interface DeliveryRecord {
  /** Decimal string (bigserial on PostgreSQL) */
  id: string;
  subscriptionId: string;
  eventSeq: number;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  lastStatusCode?: number;
  lastError?: string;
  lastDurationMs?: number;
  lastAddress?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryResult {
  outcome: 'succeeded' | 'retry' | 'dead';
  at: string;
  /** retry only; defaults to `at` */
  nextAttemptAt?: string;
  statusCode?: number;
  error?: string;
  durationMs?: number;
  address?: string;
}

export interface DeliveryStats {
  subscriptionId: string;
  pending: number;
  inFlight: number;
  dead: number;
  succeeded: number;
  /** createdAt of the oldest row still waiting (pending or in-flight) */
  oldestPendingAt?: string;
}

export interface Versioned<T> {
  value: T;
  revision: number;
  updatedAt: string;
  actorId?: string;
  actorName?: string;
}

export interface ExternalRef {
  /** Includes tenant/client, e.g. "sap-s4:PRD:100", "icube:WACE" */
  system: string;
  /** equipment | plant | functionalLocation | workCenter | costCenter | material | equipmentCode | … */
  type: string;
  id: string;
  /** Project into specificAssetIds (never for costCenter / sensitive) */
  publish?: boolean;
  /** Never exported, never in events */
  sensitive?: boolean;
  /** IRI of the issuing system, used in projection */
  externalSubjectId?: string;
  syncedAt?: string;
  source?: string;
}

export type ExternalRefSubjectKey =
  | { kind: 'asset'; globalAssetId: string }
  | { kind: 'bomChild'; globalAssetId: string }
  | { kind: 'consumable' | 'tool'; globalAssetId: string; key: string };

export interface ExternalRefSubject {
  subject: ExternalRefSubjectKey;
  refs: ExternalRef[];
}

export interface ExternalRefsDoc {
  schema: 'vexplor.externalRefs/1';
  subjects: ExternalRefSubject[];
  managedSpecificAssetIds?: string[];
}

export const EXTERNAL_REFS_SCHEMA = 'vexplor.externalRefs/1';

/** The subject string used by uniqueness and `findExternalRef`: `<kind>|<globalAssetId>[|<key>]` */
export function externalRefSubjectString(subject: ExternalRefSubjectKey): string {
  return 'key' in subject ? `${subject.kind}|${subject.globalAssetId}|${subject.key}` : `${subject.kind}|${subject.globalAssetId}`;
}

export interface ExternalRefClaim {
  system: string;
  type: string;
  id: string;
  packageId: string;
  subject: string;
}

/** (system, type, id) already claimed by another subject — mapped to 409. `claims` lists the existing and the new claim */
export class ExternalRefConflictError extends Error {
  constructor(readonly claims: ExternalRefClaim[]) {
    super(
      fill(tr('외부 참조가 이미 다른 대상에 연결되어 있습니다: {0}'), {
        0: claims.map((claim) => `${claim.system}|${claim.type}|${claim.id} → ${claim.packageId} ${claim.subject}`).join('; '),
      }),
    );
    this.name = 'ExternalRefConflictError';
  }
}

export interface IntegrationStore {
  // ── events (model events are written internally by the mutating methods, never through appendEvents) ──
  /** Returns the inserted rows only — an id that already exists (or repeats in the batch) is skipped */
  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]>;
  /** With `scope`: own and ownerless rows only */
  readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage>;
  /** Removes rows with `recordedAt < before`; returns the count */
  pruneEvents(before: string): Promise<number>;

  // ── subscriptions ──
  /** Without secrets, ordered by createdAt then id */
  listSubscriptions(): Promise<SubscriptionRecord[]>;
  getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined>;
  createSubscription(input: NewSubscription): Promise<SubscriptionRecord>;
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined>;
  /** Cascades deliveries */
  deleteSubscription(id: string): Promise<boolean>;

  // ── deliveries ──
  /** Idempotent on (subscriptionId, eventSeq); rows of an unknown subscription are skipped. Returns the inserted count */
  enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number>;
  /** Due pending + expired in-flight, oldest `nextAttemptAt` first; sets in-flight, leaseUntil = now + leaseMs, attempts + 1 */
  claimDeliveries(now: string, limit: number, leaseMs: number): Promise<DeliveryRecord[]>;
  /** Unknown id (e.g. the subscription was deleted meanwhile) is a no-op. Only the delivery row changes */
  completeDelivery(id: string, result: DeliveryResult): Promise<void>;
  getDelivery(id: string): Promise<DeliveryRecord | undefined>;
  /** Newest first; the cursor is the id of the last returned row */
  listDeliveries(subscriptionId: string, query?: { status?: DeliveryStatus } & PageQuery): Promise<PageResult<DeliveryRecord>>;
  /** -> pending, nextAttemptAt = now, lease cleared, attempts kept */
  redeliver(id: string, now: string): Promise<boolean>;
  /** One entry per subscription, including subscriptions without deliveries */
  deliveryStats(): Promise<DeliveryStats[]>;
  /** Removes succeeded rows with updatedAt < succeededBefore and dead rows with updatedAt < deadBefore */
  pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number>;

  // ── configuration (opaque JSON; validated in the API layer) ──
  getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined>;
  /** First put = revision 1, each put + 1; `expectedRevision` mismatch → ConflictError (0 = "never saved") */
  putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>>;
  getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined>;
  /** Unknown package → NotFoundError */
  putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>>;

  // ── external references (sidecar, not in the AASX) ──
  getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined>;
  /** ConflictError | ExternalRefConflictError | NotFoundError (unknown package) */
  putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>>;
  findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]>;
  /** Ordered by packageId */
  listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]>;

  // ── internal runtime state (detector, projector, dispatcher cursors) ──
  getRuntimeState(key: string): Promise<unknown | undefined>;
  /** With packageId the row is deleted with the package; unknown package → NotFoundError */
  putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void>;
}
