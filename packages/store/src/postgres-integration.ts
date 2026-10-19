/**
 * PostgreSQL part of the integration store port (docs/design/integration-v1.md §3.4) — event log (outbox),
 * subscriptions, deliveries, configuration, external references and runtime state.
 *
 * `PostgresStore` delegates its `IntegrationStore` methods to `PostgresIntegration` and calls `recordModelEvent` with
 * the **same transaction client** as its model write, so a model change and its event commit or roll back together.
 *
 * Conventions shared with postgres.ts:
 * - Only the `SqlClient` port is used, so `pg` and PGlite both plug in.
 * - jsonb is always read as `::text` and parsed here. Drivers disagree on whether jsonb arrives parsed; for a jsonb
 *   string value the two forms cannot be told apart afterwards (`"a"` vs `a`), so the driver is not asked to parse.
 * - bigserial values arrive as strings from `pg` and are converted explicitly.
 * - Times written by this file are ISO strings from the caller or JS; `recorded_at` is the DB clock truncated to
 *   milliseconds, so a value read back compares exactly with the same value passed in again (prune cut-offs).
 * - The shape of every returned record matches the memory implementation: an empty column is an absent key.
 */
import { randomUUID } from 'node:crypto';

import { fill, tr } from '@aas/core';

import { actorFields } from './actor.js';
import {
  ExternalRefConflictError,
  externalRefSubjectString,
  ORPHAN_OWNER,
  type ExternalRefsBatchItem,
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
import { EventScanner } from './event-scan.js';
import { externalRefsUpdatedEvent, firstShellFacts, type ModelEvent, type PackageFacts } from './model-events.js';
import type { SqlClient } from './postgres.js';
import { ConflictError, NotFoundError, type PackageScope, type PageQuery, type PageResult } from './types.js';

const MAX_PAGE = 1000;
const DEFAULT_DELIVERY_PAGE = 100;

/** Runs `fn` atomically — the driver's own transaction when it has one (pg.Pool must), else BEGIN/COMMIT */
export async function withTransaction<T>(client: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  if (client.transaction) return client.transaction(fn);
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Raw rows fetched per round trip while scanning */
const RAW_BATCH = 500;

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)));
}

/** Delivery ids are bigserial — anything else cannot exist, and casting it would be an SQL error, not "not found" */
const isDeliveryId = (id: string): boolean => /^[0-9]{1,18}$/.test(id);

const parseJson = (text: unknown): unknown => JSON.parse(String(text));
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

// ── model events ─────────────────────────────────────────────────────────────

/**
 * Package facts for a model event, read with the caller's transaction client **after** the change.
 * `revisionDelta` is 1 for a deletion (PackageFacts). Throws NotFoundError for a missing package.
 */
export async function packageFacts(tx: SqlClient, packageId: string, revisionDelta = 0): Promise<{ facts: PackageFacts; name: string }> {
  const { rows } = await tx.query<{ name: string; revision: number; owner: string | null; shell: string | null }>(
    `SELECT p.name, p.revision, p.owner, s.content::text AS shell
       FROM aas_package p
       LEFT JOIN LATERAL (
         SELECT content FROM identifiable
          WHERE package_id = p.id AND model_type = 'AssetAdministrationShell'
          ORDER BY ordinal, uid LIMIT 1
       ) s ON true
      WHERE p.id = $1`,
    [packageId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
  const shell = row.shell === null ? undefined : (parseJson(row.shell) as Record<string, unknown>);
  const facts: PackageFacts = { packageId, packageRevision: Number(row.revision) + revisionDelta, ...firstShellFacts(shell) };
  if (row.owner) facts.owner = row.owner;
  return { facts, name: row.name };
}

const EVENT_COLUMNS = `seq::text AS seq, id, type, occurred_at, recorded_at, package_id, subject, package_revision, owner,
  actor_id, actor_name, cause, change_set_id, data::text AS data`;

interface EventRow {
  seq: string;
  id: string;
  type: string;
  occurred_at: unknown;
  recorded_at: unknown;
  package_id: string | null;
  subject: string | null;
  package_revision: number | null;
  owner: string | null;
  actor_id: string | null;
  actor_name: string | null;
  cause: string | null;
  change_set_id: string | null;
  data: string;
}

function toStoredEvent(row: EventRow): StoredEvent {
  const event: StoredEvent = {
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    time: toIso(row.occurred_at),
    recordedAt: toIso(row.recorded_at),
    data: parseJson(row.data) as Record<string, unknown>,
  };
  if (row.package_id !== null) event.packageId = row.package_id;
  if (row.subject !== null) event.subject = row.subject;
  if (row.package_revision !== null) event.packageRevision = Number(row.package_revision);
  if (row.owner !== null) event.owner = row.owner;
  if (row.actor_id !== null) event.actorId = row.actor_id;
  if (row.actor_name !== null) event.actorName = row.actor_name;
  if (row.cause !== null) event.cause = row.cause;
  if (row.change_set_id !== null) event.changeSetId = row.change_set_id;
  return event;
}

/**
 * Inserts one event; returns the row, or undefined when the id already exists.
 *
 * Owner: a model event passes the owner it read inside its own transaction (`{ value }`). An appended event uses its
 * explicit `owner` (null = shared) if it has one, else the package's owner, else ORPHAN_OWNER when the package is gone —
 * never "shared", which every workspace could read (integration-types.ts ORPHAN_OWNER).
 *
 * Important: `INSERT … SELECT … WHERE NOT EXISTS`, not a bare `ON CONFLICT DO NOTHING`. The conflict clause runs after
 *    the bigserial default has taken a sequence value, so every deduplicated append left a gap in `seq`, and a pull-feed
 *    reader holds at a young gap for the settle time (settledPrefix). With zero selected rows no value is taken. The
 *    conflict clause stays for the rare race of two concurrent appends of one id.
 */
async function insertEvent(client: SqlClient, event: NewEvent, owner: { value: string | undefined } | 'lookup'): Promise<StoredEvent | undefined> {
  let ownerSql: string;
  let ownerParam: string | null;
  if (owner !== 'lookup') {
    ownerSql = '$12::text';
    ownerParam = owner.value ?? null;
  } else if (event.owner !== undefined) {
    ownerSql = '$12::text';
    ownerParam = event.owner;
  } else {
    ownerSql = `CASE WHEN $4::text IS NULL THEN NULL
                     WHEN EXISTS (SELECT 1 FROM aas_package WHERE id = $4::text) THEN (SELECT owner FROM aas_package WHERE id = $4::text)
                     ELSE $12::text END`;
    ownerParam = ORPHAN_OWNER;
  }
  const params: unknown[] = [
    event.id,
    event.type,
    event.time,
    event.packageId ?? null,
    event.subject ?? null,
    event.packageRevision ?? null,
    event.actorId ?? null,
    event.actorName ?? null,
    event.cause ?? null,
    event.changeSetId ?? null,
    JSON.stringify(event.data),
    ownerParam,
  ];
  const { rows } = await client.query<EventRow>(
    `INSERT INTO integration_event
       (id, type, occurred_at, recorded_at, package_id, subject, package_revision, owner, actor_id, actor_name, cause, change_set_id, data)
     SELECT $1::text, $2::text, $3::timestamptz, date_trunc('milliseconds', clock_timestamp()),
            $4::text, $5::text, $6::integer, ${ownerSql}, $7::text, $8::text, $9::text, $10::text, $11::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM integration_event WHERE id = $1::text)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    params,
  );
  return rows[0] ? toStoredEvent(rows[0]) : undefined;
}

/** Writes a model event with the caller's transaction client — rolled back with the model change */
export async function recordModelEvent(tx: SqlClient, event: ModelEvent): Promise<void> {
  const { owner, ...rest } = event;
  await insertEvent(tx, rest, { value: owner });
}

// ── row mapping ──────────────────────────────────────────────────────────────

const SUBSCRIPTION_COLUMNS = `id, name, kind, url, types::text AS types, package_ids::text AS package_ids, enabled, disabled_reason,
  options::text AS options, secret_hint, consecutive_dead, last_success_at, created_at, updated_at, created_by,
  key_id, secret_sealed, previous_sealed, previous_until, credentials_sealed`;

interface SubscriptionRow {
  id: string;
  name: string;
  kind: string;
  url: string;
  types: string;
  package_ids: string;
  enabled: boolean;
  disabled_reason: string | null;
  options: string;
  secret_hint: string;
  consecutive_dead: number;
  last_success_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  created_by: string | null;
  key_id: string;
  secret_sealed: string;
  previous_sealed: string | null;
  previous_until: unknown;
  credentials_sealed: string | null;
}

function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  const record: SubscriptionRecord = {
    id: row.id,
    name: row.name,
    kind: row.kind as SubscriptionRecord['kind'],
    url: row.url,
    types: parseJson(row.types) as string[],
    packageIds: parseJson(row.package_ids) as string[],
    enabled: row.enabled,
    options: parseJson(row.options) as SubscriptionRecord['options'],
    secretHint: row.secret_hint,
    consecutiveDead: Number(row.consecutive_dead),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (row.disabled_reason !== null) record.disabledReason = row.disabled_reason;
  if (row.last_success_at !== null && row.last_success_at !== undefined) record.lastSuccessAt = toIso(row.last_success_at);
  if (row.created_by !== null) record.createdBy = row.created_by;
  return record;
}

function toSecrets(row: SubscriptionRow): SubscriptionSecrets {
  const secrets: SubscriptionSecrets = { keyId: row.key_id, secretSealed: row.secret_sealed };
  if (row.previous_sealed !== null) secrets.previousSealed = row.previous_sealed;
  if (row.previous_until !== null && row.previous_until !== undefined) secrets.previousUntil = toIso(row.previous_until);
  if (row.credentials_sealed !== null) secrets.credentialsSealed = row.credentials_sealed;
  return secrets;
}

const DELIVERY_COLUMNS = `id::text AS id, subscription_id, event_seq::text AS event_seq, event_id, status, attempts, next_attempt_at,
  lease_until, last_status_code, last_error, last_duration_ms, last_address, created_at, updated_at`;

interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_seq: string;
  event_id: string;
  status: string;
  attempts: number;
  next_attempt_at: unknown;
  lease_until: unknown;
  last_status_code: number | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_address: string | null;
  created_at: unknown;
  updated_at: unknown;
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  const record: DeliveryRecord = {
    id: String(row.id),
    subscriptionId: row.subscription_id,
    eventSeq: Number(row.event_seq),
    eventId: row.event_id,
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: toIso(row.next_attempt_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (row.lease_until !== null && row.lease_until !== undefined) record.leaseUntil = toIso(row.lease_until);
  if (row.last_status_code !== null) record.lastStatusCode = Number(row.last_status_code);
  if (row.last_error !== null) record.lastError = row.last_error;
  if (row.last_duration_ms !== null) record.lastDurationMs = Number(row.last_duration_ms);
  if (row.last_address !== null) record.lastAddress = row.last_address;
  return record;
}

interface VersionedRow {
  value: string;
  revision: number;
  updated_at: unknown;
  actor_id: string | null;
  actor_name: string | null;
}

function toVersioned<T>(row: VersionedRow): Versioned<T> {
  const versioned: Versioned<T> = { value: parseJson(row.value) as T, revision: Number(row.revision), updatedAt: toIso(row.updated_at) };
  if (row.actor_id !== null) versioned.actorId = row.actor_id;
  if (row.actor_name !== null) versioned.actorName = row.actor_name;
  return versioned;
}

/** JSON array form — unambiguous whatever characters the three parts contain (same key as the memory log) */
const refKey = (system: string, type: string, id: string): string => JSON.stringify([system, type, id]);

// ── the store part ───────────────────────────────────────────────────────────

export class PostgresIntegration implements IntegrationStore {
  constructor(private readonly client: SqlClient) {}

  private async packageExists(packageId: string, client: SqlClient = this.client): Promise<void> {
    const { rows } = await client.query('SELECT 1 AS ok FROM aas_package WHERE id = $1', [packageId]);
    if (rows.length === 0) throw new NotFoundError(packageId);
  }

  // ── events ──

  async appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    return withTransaction(this.client, async (tx) => {
      const inserted: StoredEvent[] = [];
      for (const event of events) {
        const row = await insertEvent(tx, event, 'lookup');
        if (row) inserted.push(row);
      }
      return inserted;
    });
  }

  async readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage> {
    // Raw rows in seq order — the settle rule needs the unfiltered sequence; filtering happens in the shared scanner
    const scanner = new EventScanner(query, scope, clampLimit(query.limit, 200));
    let after = Math.max(0, Math.floor(query.after));
    for (;;) {
      const { rows } = await this.client.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM integration_event WHERE seq > $1::bigint ORDER BY seq LIMIT $2`,
        [after, RAW_BATCH],
      );
      let more = true;
      for (const row of rows) {
        more = scanner.push(toStoredEvent(row));
        if (!more) break;
      }
      if (!more || rows.length < RAW_BATCH) break;
      after = Number(rows[rows.length - 1]!.seq);
    }
    const bounds = await this.client.query<{ oldest: string | null; last: string | null }>(
      'SELECT min(seq)::text AS oldest, max(seq)::text AS last FROM integration_event',
    );
    const range = bounds.rows[0];
    return {
      items: scanner.items,
      oldestSeq: range?.oldest === null || range?.oldest === undefined ? null : Number(range.oldest),
      lastSeq: range?.last === null || range?.last === undefined ? 0 : Number(range.last),
      frontier: scanner.frontier,
    };
  }

  async pruneEvents(before: string): Promise<number> {
    const { rows } = await this.client.query<{ n: string }>(
      'WITH gone AS (DELETE FROM integration_event WHERE recorded_at < $1::timestamptz RETURNING 1) SELECT count(*)::text AS n FROM gone',
      [before],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ── subscriptions ──

  async listSubscriptions(): Promise<SubscriptionRecord[]> {
    const { rows } = await this.client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM integration_subscription ORDER BY created_at, id`,
    );
    return rows.map(toSubscription);
  }

  async getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined> {
    const { rows } = await this.client.query<SubscriptionRow>(`SELECT ${SUBSCRIPTION_COLUMNS} FROM integration_subscription WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? { ...toSubscription(row), secrets: toSecrets(row) } : undefined;
  }

  async createSubscription(input: NewSubscription): Promise<SubscriptionRecord> {
    const at = new Date().toISOString();
    const { rows } = await this.client.query<SubscriptionRow>(
      `INSERT INTO integration_subscription
         (id, name, kind, url, types, package_ids, enabled, disabled_reason, options, key_id, secret_sealed, previous_sealed,
          previous_until, credentials_sealed, secret_hint, consecutive_dead, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13::timestamptz, $14, $15, 0, $16,
               $17::timestamptz, $17::timestamptz)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        `sub_${randomUUID().replace(/-/g, '')}`,
        input.name,
        input.kind,
        input.url,
        JSON.stringify(input.types),
        JSON.stringify(input.packageIds),
        input.enabled,
        input.disabledReason ?? null,
        JSON.stringify(input.options),
        input.secrets.keyId,
        input.secrets.secretSealed,
        input.secrets.previousSealed ?? null,
        input.secrets.previousUntil ?? null,
        input.secrets.credentialsSealed ?? null,
        input.secretHint,
        input.createdBy ?? null,
        at,
      ],
    );
    return toSubscription(rows[0]!);
  }

  async updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    // Required columns: a present `undefined` cannot remove them, so it is ignored (only optional fields are cleared)
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.types !== undefined) set('types', JSON.stringify(patch.types), '::jsonb');
    if (patch.packageIds !== undefined) set('package_ids', JSON.stringify(patch.packageIds), '::jsonb');
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.options !== undefined) set('options', JSON.stringify(patch.options), '::jsonb');
    if (patch.secretHint !== undefined) set('secret_hint', patch.secretHint);
    if (patch.consecutiveDead !== undefined) set('consecutive_dead', patch.consecutiveDead, '::integer');
    // Optional columns: a present key with `undefined` clears the field (SubscriptionPatch contract)
    if (has(patch, 'disabledReason')) set('disabled_reason', patch.disabledReason ?? null);
    if (has(patch, 'lastSuccessAt')) set('last_success_at', patch.lastSuccessAt ?? null, '::timestamptz');
    if (patch.secrets !== undefined) {
      // `secrets` replaces the whole record — fields it lacks are cleared
      set('key_id', patch.secrets.keyId);
      set('secret_sealed', patch.secrets.secretSealed);
      set('previous_sealed', patch.secrets.previousSealed ?? null);
      set('previous_until', patch.secrets.previousUntil ?? null, '::timestamptz');
      set('credentials_sealed', patch.secrets.credentialsSealed ?? null);
    }
    set('updated_at', new Date().toISOString(), '::timestamptz');
    const { rows } = await this.client.query<SubscriptionRow>(
      `UPDATE integration_subscription SET ${sets.join(', ')} WHERE id = $1 RETURNING ${SUBSCRIPTION_COLUMNS}`,
      params,
    );
    return rows[0] ? toSubscription(rows[0]) : undefined;
  }

  async deleteSubscription(id: string): Promise<boolean> {
    // Deliveries go with it (ON DELETE CASCADE)
    const { rows } = await this.client.query('DELETE FROM integration_subscription WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ── deliveries ──

  async enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number> {
    if (rows.length === 0) return 0;
    return withTransaction(this.client, async (tx) => {
      let inserted = 0;
      for (const row of rows) {
        // WHERE EXISTS rather than the foreign key: an unknown subscription is skipped, not an error (WP0 notes)
        const result = await tx.query(
          `INSERT INTO integration_delivery (subscription_id, event_seq, event_id, status, attempts, next_attempt_at, created_at, updated_at)
           SELECT $1, $2::bigint, $3, 'pending', 0, $4::timestamptz, $4::timestamptz, $4::timestamptz
            WHERE EXISTS (SELECT 1 FROM integration_subscription WHERE id = $1)
           ON CONFLICT (subscription_id, event_seq) DO NOTHING
           RETURNING id`,
          [row.subscriptionId, row.eventSeq, row.eventId, now],
        );
        inserted += result.rows.length;
      }
      return inserted;
    });
  }

  async claimDeliveries(now: string, limit: number, leaseMs: number, subscriptionId?: string): Promise<DeliveryRecord[]> {
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    // SKIP LOCKED: two dispatchers (two server instances) never claim the same row inside one lease
    const { rows } = await this.client.query<DeliveryRow>(
      `UPDATE integration_delivery
          SET status = 'in-flight', lease_until = $2::timestamptz, attempts = attempts + 1, updated_at = $1::timestamptz
        WHERE id IN (
          SELECT id FROM integration_delivery
           WHERE ((status = 'pending' AND next_attempt_at <= $1::timestamptz)
              OR (status = 'in-flight' AND lease_until < $1::timestamptz))
             AND ($4::text IS NULL OR subscription_id = $4::text)
           ORDER BY next_attempt_at, id
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING ${DELIVERY_COLUMNS}`,
      [now, leaseUntil, Math.max(0, Math.floor(limit)), subscriptionId ?? null],
    );
    // RETURNING has no order — restore the claim order (oldest due first)
    return rows
      .map(toDelivery)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || Number(a.id) - Number(b.id));
  }

  /**
   * Conditional on the claim still being current (status and attempt in the WHERE), so a late result of a worker whose
   * lease expired cannot overwrite the worker that reclaimed the row — the check and the write are one statement.
   */
  async completeDelivery(id: string, result: DeliveryResult): Promise<boolean> {
    if (!isDeliveryId(id)) return false;
    const status = result.outcome === 'retry' ? 'pending' : result.outcome;
    const { rows } = await this.client.query(
      `UPDATE integration_delivery
          SET status = $2, next_attempt_at = COALESCE($3::timestamptz, next_attempt_at), lease_until = NULL,
              last_status_code = $4::integer, last_error = $5, last_duration_ms = $6::integer, last_address = $7,
              updated_at = $8::timestamptz
        WHERE id = $1::bigint AND status = 'in-flight' AND ($9::integer IS NULL OR attempts = $9::integer)
        RETURNING id`,
      [
        id,
        status,
        result.outcome === 'retry' ? (result.nextAttemptAt ?? result.at) : null,
        result.statusCode ?? null,
        result.error ?? null,
        // integer column — a fractional duration from a high-resolution timer is rounded, not refused
        result.durationMs === undefined ? null : Math.round(result.durationMs),
        result.address ?? null,
        result.at,
        result.attempt ?? null,
      ],
    );
    return rows.length > 0;
  }

  async extendLease(id: string, attempt: number, leaseUntil: string): Promise<boolean> {
    if (!isDeliveryId(id)) return false;
    const { rows } = await this.client.query(
      `UPDATE integration_delivery SET lease_until = $3::timestamptz
        WHERE id = $1::bigint AND status = 'in-flight' AND attempts = $2::integer RETURNING id`,
      [id, attempt, leaseUntil],
    );
    return rows.length > 0;
  }

  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    if (!isDeliveryId(id)) return undefined;
    const { rows } = await this.client.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM integration_delivery WHERE id = $1::bigint`, [id]);
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async listDeliveries(subscriptionId: string, query: { status?: DeliveryStatus } & PageQuery = {}): Promise<PageResult<DeliveryRecord>> {
    if (query.cursor !== undefined && !isDeliveryId(query.cursor)) return { items: [] };
    const limit = clampLimit(query.limit, DEFAULT_DELIVERY_PAGE);
    const { rows } = await this.client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM integration_delivery
        WHERE subscription_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::bigint IS NULL OR id < $3::bigint)
        ORDER BY id DESC
        LIMIT $4`,
      [subscriptionId, query.status ?? null, query.cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toDelivery);
    const result: PageResult<DeliveryRecord> = { items };
    const last = items[items.length - 1];
    if (rows.length > limit && last !== undefined) result.cursor = last.id;
    return result;
  }

  async redeliver(id: string, now: string): Promise<boolean> {
    if (!isDeliveryId(id)) return false;
    const { rows } = await this.client.query(
      `UPDATE integration_delivery
          SET status = 'pending', next_attempt_at = $2::timestamptz, lease_until = NULL, updated_at = $2::timestamptz
        WHERE id = $1::bigint AND status IN ('succeeded', 'dead') RETURNING id`,
      [id, now],
    );
    return rows.length > 0;
  }

  async deliveryStats(): Promise<DeliveryStats[]> {
    const { rows } = await this.client.query<{
      id: string;
      pending: string;
      in_flight: string;
      dead: string;
      succeeded: string;
      oldest: unknown;
    }>(
      `SELECT s.id,
              count(d.id) FILTER (WHERE d.status = 'pending')::text   AS pending,
              count(d.id) FILTER (WHERE d.status = 'in-flight')::text AS in_flight,
              count(d.id) FILTER (WHERE d.status = 'dead')::text      AS dead,
              count(d.id) FILTER (WHERE d.status = 'succeeded')::text AS succeeded,
              min(d.created_at) FILTER (WHERE d.status IN ('pending', 'in-flight')) AS oldest
         FROM integration_subscription s
         LEFT JOIN integration_delivery d ON d.subscription_id = s.id
        GROUP BY s.id, s.created_at
        ORDER BY s.created_at, s.id`,
    );
    return rows.map((row) => {
      const stats: DeliveryStats = {
        subscriptionId: row.id,
        pending: Number(row.pending),
        inFlight: Number(row.in_flight),
        dead: Number(row.dead),
        succeeded: Number(row.succeeded),
      };
      if (row.oldest !== null && row.oldest !== undefined) stats.oldestPendingAt = toIso(row.oldest);
      return stats;
    });
  }

  async pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number> {
    const { rows } = await this.client.query<{ n: string }>(
      `WITH gone AS (
         DELETE FROM integration_delivery
          WHERE (status = 'succeeded' AND updated_at < $1::timestamptz)
             OR (status = 'dead' AND updated_at < $2::timestamptz)
         RETURNING 1)
       SELECT count(*)::text AS n FROM gone`,
      [succeededBefore, deadBefore],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ── configuration ──

  private async readConfig(scope: string): Promise<Versioned<unknown> | undefined> {
    const { rows } = await this.client.query<VersionedRow>(
      'SELECT value::text AS value, revision, updated_at, actor_id, actor_name FROM integration_config WHERE scope = $1',
      [scope],
    );
    return rows[0] ? toVersioned(rows[0]) : undefined;
  }

  /**
   * Revision rule without a read-then-write race: the expected revision is part of the write's WHERE (or the insert's
   * conflict target), so of two concurrent writers with the same expectation exactly one wins.
   */
  private async writeConfig(scope: string, packageId: string | null, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    const actor = actorFields();
    const json = JSON.stringify(value === undefined ? null : value);
    const at = new Date().toISOString();
    const params = [scope, packageId, json, at, actor.actorId ?? null, actor.actorName ?? null];
    const returning = 'RETURNING value::text AS value, revision, updated_at, actor_id, actor_name';
    let rows: VersionedRow[];
    try {
      if (expectedRevision === undefined) {
        ({ rows } = await this.client.query<VersionedRow>(
          `INSERT INTO integration_config (scope, package_id, value, revision, updated_at, actor_id, actor_name)
           VALUES ($1, $2, $3::jsonb, 1, $4::timestamptz, $5, $6)
           ON CONFLICT (scope) DO UPDATE SET value = EXCLUDED.value, revision = integration_config.revision + 1,
             updated_at = EXCLUDED.updated_at, actor_id = EXCLUDED.actor_id, actor_name = EXCLUDED.actor_name
           ${returning}`,
          params,
        ));
      } else if (expectedRevision === 0) {
        ({ rows } = await this.client.query<VersionedRow>(
          `INSERT INTO integration_config (scope, package_id, value, revision, updated_at, actor_id, actor_name)
           VALUES ($1, $2, $3::jsonb, 1, $4::timestamptz, $5, $6)
           ON CONFLICT (scope) DO NOTHING ${returning}`,
          params,
        ));
      } else {
        ({ rows } = await this.client.query<VersionedRow>(
          `UPDATE integration_config SET value = $3::jsonb, revision = revision + 1, updated_at = $4::timestamptz,
             actor_id = $5, actor_name = $6
           WHERE scope = $1 AND revision = $2::integer ${returning}`,
          [scope, expectedRevision, json, at, actor.actorId ?? null, actor.actorName ?? null],
        ));
      }
    } catch (error) {
      // 23503 = foreign_key_violation: the package was deleted meanwhile
      if (sqlState(error) === '23503' && packageId !== null) throw new NotFoundError(packageId);
      throw error;
    }
    if (rows[0]) return toVersioned(rows[0]);
    throw new ConflictError(expectedRevision ?? 0, (await this.readConfig(scope))?.revision ?? 0);
  }

  getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined> {
    return this.readConfig('server');
  }

  putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    return this.writeConfig('server', null, value, expectedRevision);
  }

  getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined> {
    return this.readConfig(`package:${packageId}`);
  }

  async putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    await this.packageExists(packageId);
    return this.writeConfig(`package:${packageId}`, packageId, value, expectedRevision);
  }

  // ── external references ──

  async getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined> {
    const { rows } = await this.client.query<VersionedRow>(
      'SELECT doc::text AS value, revision, updated_at, actor_id, actor_name FROM external_ref_doc WHERE package_id = $1',
      [packageId],
    );
    return rows[0] ? toVersioned<ExternalRefsDoc>(rows[0]) : undefined;
  }

  async putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>> {
    const item: ExternalRefsBatchItem = { packageId, doc, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
    return (await this.putExternalRefsBatch([item]))[0]!;
  }

  /**
   * One transaction for every item, in order; the first failure rolls all of them back.
   * Per item, the same order of checks as the memory log: package, revision, then uniqueness — a stale writer learns
   * nothing about other packages' claims. Each saved item writes its `model.externalrefs.updated` event in the same
   * transaction, so the projector can find the change in the log after a crash.
   *
   * Important: the **package row** is locked first (FOR NO KEY UPDATE — enough to serialize writers of one sidecar,
   *    and it does not block foreign-key checks of unrelated writes). Locking the sidecar row alone locks nothing on
   *    the first write, when that row does not exist yet: two first writers both read revision 0 and the slower one
   *    failed on the primary key with a raw 23505 (a 500).
   * Uniqueness against other packages is checked with a query before writing; a writer of another package that slips
   *    in between makes the key insert fail with 23505, which aborts the transaction, so its claims are read again
   *    afterwards and reported as ExternalRefConflictError — or, when no claim is found, as a ConflictError (retry).
   */
  async putExternalRefsBatch(items: readonly ExternalRefsBatchItem[]): Promise<Versioned<ExternalRefsDoc>[]> {
    if (items.length === 0) return [];
    let current: ExternalRefsBatchItem | undefined;
    try {
      return await withTransaction(this.client, async (tx) => {
        const saved: Versioned<ExternalRefsDoc>[] = [];
        for (const item of items) {
          current = item;
          saved.push(await this.putOne(tx, item));
        }
        return saved;
      });
    } catch (error) {
      const failed = current;
      if (failed === undefined) throw error;
      if (sqlState(error) === '23503') throw new NotFoundError(failed.packageId);
      if (sqlState(error) === '23505') {
        const { conflicts } = await this.conflictsFor(this.client, failed.packageId, failed.doc);
        if (conflicts.length > 0) throw new ExternalRefConflictError(conflicts);
        const latest = await this.getExternalRefs(failed.packageId);
        throw new ConflictError(failed.expectedRevision ?? 0, latest?.revision ?? 0);
      }
      throw error;
    }
  }

  private async putOne(tx: SqlClient, item: ExternalRefsBatchItem): Promise<Versioned<ExternalRefsDoc>> {
    const { packageId, doc, expectedRevision } = item;
    const pkg = await tx.query<{ owner: string | null }>('SELECT owner FROM aas_package WHERE id = $1 FOR NO KEY UPDATE', [packageId]);
    if (pkg.rows.length === 0) throw new NotFoundError(packageId);
    const current = await tx.query<{ revision: number }>('SELECT revision FROM external_ref_doc WHERE package_id = $1', [packageId]);
    const actual = current.rows[0] ? Number(current.rows[0].revision) : 0;
    if (expectedRevision !== undefined && expectedRevision !== actual) throw new ConflictError(expectedRevision, actual);

    const claims = await this.conflictsFor(tx, packageId, doc);
    if (claims.conflicts.length > 0) throw new ExternalRefConflictError(claims.conflicts);

    await tx.query('DELETE FROM external_ref_key WHERE package_id = $1', [packageId]);
    for (const claim of claims.keys) {
      await tx.query('INSERT INTO external_ref_key (system, type, ref_id, package_id, subject) VALUES ($1, $2, $3, $4, $5)', [
        claim.system,
        claim.type,
        claim.id,
        packageId,
        claim.subject,
      ]);
    }
    const actor = actorFields();
    const at = new Date().toISOString();
    const { rows } = await tx.query<VersionedRow>(
      `INSERT INTO external_ref_doc (package_id, doc, revision, updated_at, actor_id, actor_name)
       VALUES ($1, $2::jsonb, $3::integer, $4::timestamptz, $5, $6)
       ON CONFLICT (package_id) DO UPDATE SET doc = EXCLUDED.doc, revision = EXCLUDED.revision,
         updated_at = EXCLUDED.updated_at, actor_id = EXCLUDED.actor_id, actor_name = EXCLUDED.actor_name
       RETURNING doc::text AS value, revision, updated_at, actor_id, actor_name`,
      [packageId, JSON.stringify(doc), actual + 1, at, actor.actorId ?? null, actor.actorName ?? null],
    );
    await recordModelEvent(tx, externalRefsUpdatedEvent(packageId, actual + 1, at, pkg.rows[0]!.owner ?? undefined));
    return toVersioned<ExternalRefsDoc>(rows[0]!);
  }

  /** The doc's distinct claims, and conflicts (existing claim then new claim) in doc order — mirrors the memory log */
  private async conflictsFor(client: SqlClient, packageId: string, doc: ExternalRefsDoc): Promise<{ keys: ExternalRefClaim[]; conflicts: ExternalRefClaim[] }> {
    const wanted = doc.subjects.flatMap((entry) => entry.refs.map((ref) => ({ system: ref.system, type: ref.type, id: ref.id })));
    const held = new Map<string, ExternalRefClaim>();
    if (wanted.length > 0) {
      const { rows } = await client.query<{ system: string; type: string; ref_id: string; package_id: string; subject: string }>(
        `SELECT DISTINCT k.system, k.type, k.ref_id, k.package_id, k.subject
           FROM external_ref_key k
           JOIN jsonb_to_recordset($2::jsonb) AS w(system text, type text, id text)
             ON k.system = w.system AND k.type = w.type AND k.ref_id = w.id
          WHERE k.package_id <> $1`,
        [packageId, JSON.stringify(wanted)],
      );
      for (const row of rows) {
        held.set(refKey(row.system, row.type, row.ref_id), { system: row.system, type: row.type, id: row.ref_id, packageId: row.package_id, subject: row.subject });
      }
    }
    const keys = new Map<string, ExternalRefClaim>();
    const conflicts: ExternalRefClaim[] = [];
    for (const entry of doc.subjects) {
      const subject = externalRefSubjectString(entry.subject);
      for (const ref of entry.refs) {
        const key = refKey(ref.system, ref.type, ref.id);
        const claim: ExternalRefClaim = { system: ref.system, type: ref.type, id: ref.id, packageId, subject };
        const inDoc = keys.get(key);
        if (inDoc !== undefined) {
          if (inDoc.subject !== subject) conflicts.push(inDoc, claim);
          continue;
        }
        const other = held.get(key);
        if (other !== undefined) conflicts.push(other, claim);
        keys.set(key, claim);
      }
    }
    return { keys: [...keys.values()], conflicts };
  }

  async findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]> {
    const { rows } = await this.client.query<{ package_id: string; subject: string }>(
      'SELECT package_id, subject FROM external_ref_key WHERE system = $1 AND type = $2 AND ref_id = $3',
      [system, type, id],
    );
    return rows.map((row) => ({ packageId: row.package_id, subject: row.subject }));
  }

  async listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]> {
    const { rows } = await this.client.query<VersionedRow & { package_id: string }>(
      'SELECT package_id, doc::text AS value, revision, updated_at, actor_id, actor_name FROM external_ref_doc',
    );
    // Sorted here, not by ORDER BY: the DB collation may order ids differently from the memory store's localeCompare
    return rows
      .map((row) => ({ packageId: row.package_id, refs: toVersioned<ExternalRefsDoc>(row) }))
      .sort((a, b) => a.packageId.localeCompare(b.packageId));
  }

  // ── runtime state ──

  async getRuntimeState(key: string): Promise<unknown | undefined> {
    const { rows } = await this.client.query<{ value: string }>('SELECT value::text AS value FROM integration_state WHERE key = $1', [key]);
    return rows[0] ? parseJson(rows[0].value) : undefined;
  }

  async putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> {
    if (packageId !== undefined) await this.packageExists(packageId);
    try {
      await writeRuntimeState(this.client, key, value, packageId);
    } catch (error) {
      if (sqlState(error) === '23503' && packageId !== undefined) throw new NotFoundError(packageId);
      throw error;
    }
  }
}

/**
 * One runtime-state row, on the client given — also a transaction's, so a batch of values and the record that it was
 * stored commit together (postgres.ts appendValueBatch, 2.8.1).
 */
export async function writeRuntimeState(client: SqlClient, key: string, value: unknown, packageId?: string): Promise<void> {
  // jsonb has no `undefined` — storing undefined is removing the row, which reads back as undefined like the memory log
  if (value === undefined) {
    await client.query('DELETE FROM integration_state WHERE key = $1', [key]);
    return;
  }
  await client.query(
    `INSERT INTO integration_state (key, package_id, value, updated_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz)
     ON CONFLICT (key) DO UPDATE SET package_id = EXCLUDED.package_id, value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, packageId ?? null, JSON.stringify(value), new Date().toISOString()],
  );
}
