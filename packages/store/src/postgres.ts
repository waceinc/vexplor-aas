/**
 * PostgreSQL store.
 *
 * It does not depend on a driver directly and takes only the `SqlClient` port — `pg` (production) and
 * `@electric-sql/pglite` (testing/development) have the same shape, so either plugs in as-is.
 * As a result this package has zero runtime dependencies and adds nothing to the license review.
 *
 * bytea is exchanged as hex strings (`decode($n,'hex')` / `encode(data,'hex')`).
 * Binary binding conventions differ between drivers (Buffer-only pg vs Uint8Array pglite),
 * so portability was chosen. Important: storing manuals of hundreds of MB would double memory use,
 * so at that point switch to the driver-specific binary binding (spec Ⅷ, large-file item).
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { fill, tr } from '@aas/core';
import {
  deriveColumns,
  flattenEnvironment,
  flattenPackageFiles,
  toAasxPackage,
  toEnvironment,
} from './convert.js';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_VERSION_SQL } from './schema.js';
import {
  type CollectedValue,
  type NewUser,
  type UserRecord,
  type ValueQuery,
  ConflictError,
  InvalidContentError,
  NotFoundError,
  type AasStore,
  type HistoryRecord,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type ListQuery,
  type PackageFileRecord,
  type PackageRecord,
  type PageQuery,
  type PageResult,
  type WriteOptions, type CreateOptions,
  type Actor,
  type PackageScope } from './types.js';
import { resolveActor } from './actor.js';
import type {
  DeliveryRecord,
  DeliveryResult,
  DeliveryStats,
  DeliveryStatus,
  EventPage,
  EventQuery,
  ExternalRefsBatchItem,
  ExternalRefsDoc,
  IntegrationStore,
  NewEvent,
  NewSubscription,
  StoredEvent,
  SubscriptionPatch,
  SubscriptionRecord,
  SubscriptionSecrets,
  Versioned,
} from './integration-types.js';
import { identifiableEvent, packageCreatedEvent, packageDeletedEvent, packageFileEvent } from './model-events.js';
import { PostgresIntegration, packageFacts, recordModelEvent, toIso, withTransaction } from './postgres-integration.js';

const DEFAULT_LIMIT = 100;

export interface SqlResult<R> {
  rows: R[];
}

/** The minimal shape a driver must satisfy */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<R>>;
  /**
   * Atomic execution. Clients whose connection can differ per query, like `pg.Pool`, **must provide it**
   * (if BEGIN goes to a different connection, the transaction does not hold).
   * Can be omitted for a single connection (pg.Client · PGlite).
   */
  transaction?<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** Advisory lock key for schema version checks — an arbitrary value that does not clash with other uses */
const SCHEMA_LOCK_KEY = 0x00aa5501;
/** Advisory lock key for creating the first account (red-team L3) */
const FIRST_USER_LOCK_KEY = 0x00aa5502;

/** The DB schema is newer than the program — startup is refused */
export class SchemaVersionError extends Error {
  constructor(
    message: string,
    readonly found: number,
  ) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

const HEX = '0123456789abcdef';

function toHex(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

function fromHex(value: string): Uint8Array {
  // pg sometimes returns bytea in the form '\x...'
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface PackageRow {
  id: string;
  name: string;
  spec_part: string;
  revision: number;
  created_at: unknown;
  updated_at: unknown;
  owner: string | null;
}

interface IdentifiableRow {
  uid: string | number;
  package_id: string;
  model_type: string;
  id: string;
  id_short: string | null;
  semantic_id: string | null;
  asset_kind: string | null;
  kind: string | null;
  ordinal: number;
  content: Record<string, unknown>;
  revision: number;
  updated_at: unknown;
}

function toPackageRecord(row: PackageRow): PackageRecord {
  return {
    id: row.id,
    name: row.name,
    specPart: row.spec_part,
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    // Important: NULL is returned with the key omitted — the shape must match the memory store for the comparison tests to hold
    ...(row.owner ? { owner: row.owner } : {}),
  };
}

function toIdentifiableRecord(row: IdentifiableRow): IdentifiableRecord {
  const record: IdentifiableRecord = {
    uid: String(row.uid),
    packageId: row.package_id,
    modelType: row.model_type as IdentifiableModelType,
    id: row.id,
    ordinal: Number(row.ordinal),
    // Drivers already return jsonb as an object. Some return it as a string, so check once more
    content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at),
  };
  const idShort = optional(row.id_short);
  if (idShort) record.idShort = idShort;
  const semanticId = optional(row.semantic_id);
  if (semanticId) record.semanticId = semanticId;
  const assetKind = optional(row.asset_kind);
  if (assetKind) record.assetKind = assetKind;
  const kind = optional(row.kind);
  if (kind) record.kind = kind;
  return record;
}

const IDENTIFIABLE_COLUMNS =
  'uid, package_id, model_type, id, id_short, semantic_id, asset_kind, kind, ordinal, content, revision, updated_at';

export class PostgresStore implements AasStore, IntegrationStore {
  /** Integration part of the port (postgres-integration.ts). Model events are written by the methods below instead */
  private readonly integration: PostgresIntegration;

  constructor(private readonly client: SqlClient) {
    this.integration = new PostgresIntegration(client);
  }

  /** The DB schema version confirmed at startup. undefined before init() */
  schemaVersion: number | undefined;

  async init(): Promise<void> {
    await this.runStatements(SCHEMA_VERSION_SQL);
    // Important: version check and upgrade run inside one transaction + advisory lock — applied only once even if two instances start at the same time
    this.schemaVersion = await withTransaction(this.client, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      const { rows } = await tx.query<{ version: number | string | null }>(
        'SELECT max(version) AS version FROM schema_version',
      );
      const found = rows[0]?.version;
      let current = found === null || found === undefined ? 0 : Number(found);

      if (current > SCHEMA_VERSION) {
        throw new SchemaVersionError(
          // Startup error for the operator — the language comes from AAS_LANG (apps/api/src/lang.ts bootLang)
          fill(
            tr('DB 스키마가 {0}판인데 이 프로그램은 {1}판까지만 압니다 — 프로그램을 판올림하십시오. 옛 프로그램이 새 표를 읽으면 조용히 잃을 수 있어 기동하지 않습니다.'),
            { 0: current, 1: SCHEMA_VERSION },
          ),
          current,
        );
      }
      if (current === 0) {
        // An empty DB or one from before version numbers were introduced. SCHEMA_SQL (IF NOT EXISTS) **does not alter existing tables** —
        // version 1 table constraints remain as they were. So all migrations (idempotent) are run once more (found when version 2 was introduced)
        await this.runStatements(SCHEMA_SQL, tx);
        for (const step of MIGRATIONS) await this.runStatements(step.sql, tx);
        await tx.query('INSERT INTO schema_version (version) VALUES ($1)', [SCHEMA_VERSION]);
        return SCHEMA_VERSION;
      }
      for (const step of MIGRATIONS) {
        if (step.version <= current) continue;
        await this.runStatements(step.sql, tx);
        await tx.query('INSERT INTO schema_version (version) VALUES ($1)', [step.version]);
        current = step.version;
      }
      // Even if the version is the same, SCHEMA_SQL is idempotent, so run it once more to fill in missing indexes, etc.
      await this.runStatements(SCHEMA_SQL, tx);
      return current;
    });
  }

  /** Some drivers cannot send multiple statements at once, so they are sent one statement at a time */
  private async runStatements(script: string, client: SqlClient = this.client): Promise<void> {
    for (const statement of script.split(';')) {
      const sql = statement.trim();
      if (sql) await client.query(sql);
    }
  }

  private async requirePackage(packageId: string, client: SqlClient = this.client): Promise<PackageRow> {
    const { rows } = await client.query<PackageRow>('SELECT * FROM aas_package WHERE id = $1', [
      packageId,
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
    return row;
  }

  private async touch(client: SqlClient, packageId: string): Promise<void> {
    await client.query(
      'UPDATE aas_package SET revision = revision + 1, updated_at = now() WHERE id = $1',
      [packageId],
    );
  }

  private async findRow(
    client: SqlClient,
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<IdentifiableRow | undefined> {
    // Duplicate ids (KOSMO-CD-5 defect) really do come in. The first one is treated as representative
    const { rows } = await client.query<IdentifiableRow>(
      `SELECT ${IDENTIFIABLE_COLUMNS} FROM identifiable
       WHERE package_id = $1 AND model_type = $2 AND id = $3
       ORDER BY ordinal LIMIT 1`,
      [packageId, modelType, id],
    );
    return rows[0];
  }

  async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    return withTransaction(this.client, async (tx) => {
      const { rows } = await tx.query<PackageRow>(
        `INSERT INTO aas_package (id, name, spec_part, owner)
         VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4)
         RETURNING id, name, spec_part, revision, created_at, updated_at, owner`,
        [input.id ?? null, input.name, input.package.specPart, input.owner || null],
      );
      const row = rows[0];
      if (!row) throw new InvalidContentError(tr('패키지를 만들지 못했습니다.'));

      for (const file of [...flattenPackageFiles(input.package), ...(input.keep ?? [])]) {
        await tx.query(
          `INSERT INTO aas_package_file (package_id, part, role, content_type, data)
           VALUES ($1, $2, $3, $4, decode($5, 'hex'))`,
          [row.id, file.part, file.role, file.contentType, toHex(file.data)],
        );
      }

      for (const { content, ordinal } of flattenEnvironment(input.package.environment)) {
        const d = deriveColumns(content);
        await tx.query(
          `INSERT INTO identifiable
             (package_id, model_type, id, id_short, semantic_id, asset_kind, kind, ordinal, content)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            row.id,
            d.modelType,
            d.id,
            d.idShort ?? null,
            d.semanticId ?? null,
            d.assetKind ?? null,
            d.kind ?? null,
            ordinal,
            JSON.stringify(content),
          ],
        );
      }

      const counts = { AssetAdministrationShell: 0, Submodel: 0, ConceptDescription: 0 };
      for (const { content } of flattenEnvironment(input.package.environment)) counts[deriveColumns(content).modelType] += 1;
      const { facts } = await packageFacts(tx, row.id);
      await recordModelEvent(tx, packageCreatedEvent(facts, row.name, counts, new Date().toISOString()));
      return toPackageRecord(row);
    });
  }

  async exportPackage(packageId: string): Promise<AasxPackage> {
    const row = await this.requirePackage(packageId);
    const files = await this.packageFiles(packageId);
    const environment = await this.getEnvironment(packageId);
    return toAasxPackage(toPackageRecord(row), files, environment);
  }

  async appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void> {
    if (values.length === 0) return;
    await this.requirePackage(packageId);
    // Collection does not change the model — the package revision is not bumped (Option A)
    for (const value of values) {
      await this.client.query(
        `INSERT INTO collected_value
           (package_id, interface_name, property_name, source, observed_at, value_number, value_text, quality, received_at, value_key, error)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::timestamptz, $10, $11)
         ON CONFLICT DO NOTHING`,
        [
          packageId,
          value.interfaceName,
          value.propertyName,
          value.source ?? null,
          value.observedAt,
          value.valueNumber ?? null,
          value.valueText ?? null,
          value.quality ?? null,
          value.receivedAt ?? null,
          value.key ?? null,
          value.error ?? null,
        ],
      );
    }
  }

  async pruneValues(before: string): Promise<number> {
    const dropped = await this.dropOldChunks(before);
    // SqlResult has no rowCount, so count via RETURNING
    const { rows } = await this.client.query<{ n: number }>(
      // Judged by receive time — for constant-value tags the device time is frozen, so deleting by device time would also delete values just received
      'DELETE FROM collected_value WHERE COALESCE(received_at, observed_at) < $1::timestamptz RETURNING 1 AS n',
      [before],
    );
    return dropped + rows.length;
  }

  /**
   * On a TimescaleDB hypertable, whole chunks that end before `before` are dropped instead of deleted row by row —
   * deleting from a compressed chunk would decompress it first (lead request §6 H2). The rule stays the receive time:
   * a chunk that still holds a value received after `before` (a constant tag whose device time is frozen) is left to
   * the row delete. Plain PostgreSQL has no chunks; nothing happens.
   */
  private async dropOldChunks(before: string): Promise<number> {
    const { rows: catalog } = await this.client.query<{ present: boolean }>(
      "SELECT to_regclass('timescaledb_information.chunks') IS NOT NULL AS present",
    );
    if (!catalog[0]?.present) return 0;
    const { rows: chunks } = await this.client.query<{ chunk: string }>(
      `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk FROM timescaledb_information.chunks
        WHERE hypertable_schema = current_schema() AND hypertable_name = 'collected_value' AND range_end <= $1::timestamptz
        ORDER BY range_start`,
      [before],
    );
    let dropped = 0;
    for (const { chunk } of chunks) {
      // The name comes from the catalog, quoted by format(%I)
      const { rows } = await this.client.query<{ total: number; recent: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE COALESCE(received_at, observed_at) >= $1::timestamptz)::int AS recent FROM ${chunk}`,
        [before],
      );
      if ((rows[0]?.recent ?? 0) > 0) continue;
      await this.client.query(`DROP TABLE ${chunk}`);
      dropped += rows[0]?.total ?? 0;
    }
    return dropped;
  }

  async readValues(packageId: string, query: ValueQuery = {}): Promise<CollectedValue[]> {
    // The column name is one of two fixed values, so inserting it as a string allows no injection
    const at = query.basis === 'received' ? 'COALESCE(received_at, observed_at)' : 'observed_at';
    // A missing package is NotFound, not an empty list — must match the in-memory implementation (conformance tests)
    await this.requirePackage(packageId);
    const { rows } = await this.client.query<{
      interface_name: string;
      property_name: string;
      source: string | null;
      observed_at: unknown;
      value_number: number | null;
      value_text: string | null;
      quality: string | null;
      received_at: unknown;
      error: string | null;
    }>(
      `SELECT interface_name, property_name, source, observed_at, value_number, value_text, quality, received_at, error
       FROM collected_value
       WHERE package_id = $1
         AND ($2::text IS NULL OR interface_name = $2)
         AND ($3::text IS NULL OR property_name = $3)
         AND ($4::timestamptz IS NULL OR ${at} >= $4)
         AND ($5::timestamptz IS NULL OR ${at} < $5)
       ORDER BY ${at} DESC
       LIMIT $6`,
      [
        packageId,
        query.interfaceName ?? null,
        query.propertyName ?? null,
        query.from ?? null,
        query.to ?? null,
        query.limit ?? 1000,
      ],
    );

    return rows.map((row) => {
      const value: CollectedValue = {
        packageId,
        interfaceName: row.interface_name,
        propertyName: row.property_name,
        observedAt: toIso(row.observed_at),
      };
      if (row.source !== null) value.source = row.source;
      if (row.value_number !== null) value.valueNumber = Number(row.value_number);
      if (row.value_text !== null) value.valueText = row.value_text;
      if (row.quality !== null) value.quality = row.quality;
      if (row.received_at !== null && row.received_at !== undefined) value.receivedAt = toIso(row.received_at);
      if (row.error !== null && row.error !== undefined) value.error = row.error;
      return value;
    });
  }

  async packageFiles(packageId: string): Promise<PackageFileRecord[]> {
    const { rows } = await this.client.query<{
      part: string;
      role: string;
      content_type: string;
      data_hex: string;
    }>(
      `SELECT part, role, content_type, encode(data, 'hex') AS data_hex
       FROM aas_package_file WHERE package_id = $1 ORDER BY part`,
      [packageId],
    );
    return rows.map((r) => ({
      part: r.part,
      role: r.role as PackageFileRecord['role'],
      contentType: r.content_type,
      data: fromHex(r.data_hex),
    }));
  }

  async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    // A transaction now (2026-10-14): the file, the revision bump and the model event commit together
    await withTransaction(this.client, async (tx) => {
      await this.requirePackage(packageId, tx);
      await tx.query(
        `INSERT INTO aas_package_file (package_id, part, role, content_type, data)
         VALUES ($1, $2, $3, $4, decode($5, 'hex'))
         ON CONFLICT (package_id, part)
         DO UPDATE SET role = EXCLUDED.role, content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
        [packageId, file.part, file.role, file.contentType, toHex(file.data)],
      );
      await this.touch(tx, packageId);
      const { facts } = await packageFacts(tx, packageId);
      await recordModelEvent(tx, packageFileEvent(facts, file.part, file.role, 'put', new Date().toISOString()));
    });
  }

  async deletePackageFile(packageId: string, part: string): Promise<void> {
    await withTransaction(this.client, async (tx) => {
      const { rows } = await tx.query<{ role: string }>(
        'DELETE FROM aas_package_file WHERE package_id = $1 AND part = $2 RETURNING role',
        [packageId, part],
      );
      if (rows.length === 0) throw new NotFoundError(fill(tr('파트 {0}'), { 0: part }));
      await this.touch(tx, packageId);
      const { facts } = await packageFacts(tx, packageId);
      await recordModelEvent(tx, packageFileEvent(facts, part, rows[0]!.role, 'delete', new Date().toISOString()));
    });
  }

  async getPackage(packageId: string): Promise<PackageRecord | undefined> {
    const { rows } = await this.client.query<PackageRow>(
      'SELECT * FROM aas_package WHERE id = $1',
      [packageId],
    );
    const row = rows[0];
    return row ? toPackageRecord(row) : undefined;
  }

  async listPackages(page: PageQuery = {}, scope?: PackageScope): Promise<PageResult<PackageRecord>> {
    const limit = page.limit ?? DEFAULT_LIMIT;
    // Important: the filter condition must be **inside** the LIMIT — fetching and filtering outside leaves a page short
    const { rows } = await this.client.query<PackageRow>(
      `SELECT * FROM aas_package
       WHERE ($1::text IS NULL OR id > $1)
         AND ($3::text IS NULL OR owner IS NULL OR owner = $3)
       ORDER BY id LIMIT $2`,
      [page.cursor ?? null, limit + 1, scope?.owner ?? null],
    );
    return slicePage(rows.map(toPackageRecord), limit, (r) => r.id);
  }

  async deletePackage(packageId: string): Promise<void> {
    await withTransaction(this.client, async (tx) => {
      // Facts before the rows go. Config, refs, keys and runtime state cascade (ON DELETE CASCADE); events stay
      const before = await packageFacts(tx, packageId, 1);
      await tx.query('DELETE FROM aas_package WHERE id = $1', [packageId]);
      await recordModelEvent(tx, packageDeletedEvent(before.facts, before.name, new Date().toISOString()));
    });
  }

  async getEnvironment(packageId: string): Promise<Environment> {
    await this.requirePackage(packageId);
    const { rows } = await this.client.query<IdentifiableRow>(
      `SELECT ${IDENTIFIABLE_COLUMNS} FROM identifiable WHERE package_id = $1 ORDER BY ordinal`,
      [packageId],
    );
    return toEnvironment(rows.map(toIdentifiableRecord));
  }

  async listIdentifiables(
    packageId: string,
    modelType: IdentifiableModelType,
    query: ListQuery = {},
  ): Promise<PageResult<IdentifiableRecord>> {
    await this.requirePackage(packageId);
    const limit = query.limit ?? DEFAULT_LIMIT;
    // All filters are on derived columns, so they use indexes. If NULL, the condition is true as a whole
    const { rows } = await this.client.query<IdentifiableRow>(
      `SELECT ${IDENTIFIABLE_COLUMNS} FROM identifiable
       WHERE package_id = $1 AND model_type = $2 AND ($3::int IS NULL OR ordinal > $3)
         AND ($5::text IS NULL OR id_short = $5)
         AND ($6::text IS NULL OR semantic_id = $6)
         AND ($7::text IS NULL OR asset_kind = $7)
       ORDER BY ordinal LIMIT $4`,
      [
        packageId,
        modelType,
        query.cursor ?? null,
        limit + 1,
        query.idShort ?? null,
        query.semanticId ?? null,
        query.assetKind ?? null,
      ],
    );
    return slicePage(rows.map(toIdentifiableRecord), limit, (r) => String(r.ordinal));
  }

  async getIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<IdentifiableRecord | undefined> {
    await this.requirePackage(packageId);
    const row = await this.findRow(this.client, packageId, modelType, id);
    return row ? toIdentifiableRecord(row) : undefined;
  }

  async createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options: CreateOptions = {},
  ): Promise<IdentifiableRecord> {
    const d = deriveColumns(content);
    return withTransaction(this.client, async (tx) => {
      await this.requirePackage(packageId, tx);
      if (await this.findRow(tx, packageId, d.modelType, d.id)) {
        throw new InvalidContentError(fill(tr('이미 있는 id입니다: {0}'), { 0: d.id }));
      }
      // At the given position if specified (COALESCE), otherwise at the end
      const { rows } = await tx.query<IdentifiableRow>(
        `INSERT INTO identifiable
           (package_id, model_type, id, id_short, semantic_id, asset_kind, kind, ordinal, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 COALESCE($9::integer, (SELECT COALESCE(MAX(ordinal) + 1, 0) FROM identifiable WHERE package_id = $1)),
                 $8::jsonb)
         RETURNING ${IDENTIFIABLE_COLUMNS}`,
        [
          packageId,
          d.modelType,
          d.id,
          d.idShort ?? null,
          d.semanticId ?? null,
          d.assetKind ?? null,
          d.kind ?? null,
          JSON.stringify(content),
          options.ordinal ?? null,
        ],
      );
      await this.touch(tx, packageId);
      const record = toIdentifiableRecord(rows[0]!);
      const { facts } = await packageFacts(tx, packageId);
      await recordModelEvent(tx, identifiableEvent(facts, record, 'create', record.revision, new Date().toISOString()));
      return record;
    });
  }

  async updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options: WriteOptions = {},
  ): Promise<IdentifiableRecord> {
    const d = deriveColumns(content);
    if (d.modelType !== modelType || d.id !== id) {
      throw new InvalidContentError(
        fill(tr('본문의 modelType·id가 경로와 다릅니다: {0} {1}. id를 바꾸려면 참조 무결성 때문에 Quick Fix의 교정 경로를 쓰십시오.'), {
          0: d.modelType,
          1: d.id,
        }),
      );
    }

    return withTransaction(this.client, async (tx) => {
      await this.requirePackage(packageId, tx);
      const current = await this.findRow(tx, packageId, modelType, id);
      if (!current) throw new NotFoundError(`${modelType} ${id}`);
      checkRevision(options, Number(current.revision));

      await this.pushHistory(tx, current, 'update', options.actor);
      const { rows } = await tx.query<IdentifiableRow>(
        `UPDATE identifiable
         SET content = $2::jsonb, id_short = $3, semantic_id = $4, asset_kind = $5, kind = $6,
             revision = revision + 1, updated_at = now()
         WHERE uid = $1
         RETURNING ${IDENTIFIABLE_COLUMNS}`,
        [
          current.uid,
          JSON.stringify(content),
          d.idShort ?? null,
          d.semanticId ?? null,
          d.assetKind ?? null,
          d.kind ?? null,
        ],
      );
      await this.touch(tx, packageId);
      const record = toIdentifiableRecord(rows[0]!);
      const { facts } = await packageFacts(tx, packageId);
      await recordModelEvent(tx, identifiableEvent(facts, record, 'update', record.revision, new Date().toISOString(), options.actor));
      return record;
    });
  }

  async deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options: WriteOptions = {},
  ): Promise<void> {
    await withTransaction(this.client, async (tx) => {
      await this.requirePackage(packageId, tx);
      const current = await this.findRow(tx, packageId, modelType, id);
      if (!current) throw new NotFoundError(`${modelType} ${id}`);
      checkRevision(options, Number(current.revision));

      await this.pushHistory(tx, current, 'delete', options.actor);
      await tx.query('DELETE FROM identifiable WHERE uid = $1', [current.uid]);
      await this.touch(tx, packageId);
      const record = toIdentifiableRecord(current);
      const { facts } = await packageFacts(tx, packageId);
      await recordModelEvent(tx, identifiableEvent(facts, record, 'delete', record.revision, new Date().toISOString(), options.actor));
    });
  }

  private async pushHistory(
    tx: SqlClient,
    row: IdentifiableRow,
    operation: 'update' | 'delete',
    explicitActor?: Actor,
  ): Promise<void> {
    // "Who" — from the request context if not explicit. NULL if absent (servers without login)
    const actor = resolveActor(explicitActor);
    await tx.query(
      `INSERT INTO identifiable_history
         (uid, package_id, model_type, id, revision, content, operation, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        row.uid,
        row.package_id,
        row.model_type,
        row.id,
        row.revision,
        JSON.stringify(row.content),
        operation,
        actor?.id ?? null,
        actor?.name ?? null,
      ],
    );
  }

  async history(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<HistoryRecord[]> {
    const { rows } = await this.client.query<{
      uid: string | number;
      package_id: string;
      model_type: string;
      id: string;
      revision: number;
      content: Record<string, unknown>;
      operation: string;
      changed_at: unknown;
      actor_id: string | null;
      actor_name: string | null;
    }>(
      `SELECT uid, package_id, model_type, id, revision, content, operation, changed_at,
              actor_id, actor_name
       FROM identifiable_history
       WHERE package_id = $1 AND model_type = $2 AND id = $3
       ORDER BY history_id DESC`,
      [packageId, modelType, id],
    );
    return rows.map((r) => ({
      uid: String(r.uid),
      packageId: r.package_id,
      modelType: r.model_type as IdentifiableModelType,
      id: r.id,
      revision: Number(r.revision),
      content: typeof r.content === 'string' ? JSON.parse(r.content) : r.content,
      operation: r.operation as HistoryRecord['operation'],
      changedAt: toIso(r.changed_at),
      // Important: null is returned with the key omitted — the shape must match the memory store for the comparison tests to hold
      ...(r.actor_id === null ? {} : { actorId: r.actor_id }),
      ...(r.actor_name === null ? {} : { actorName: r.actor_name }),
    }));
  }

  // ── Integration (docs/design/integration-v1.md §3) — postgres-integration.ts ──
  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> { return this.integration.appendEvents(events); }
  readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage> { return this.integration.readEvents(query, scope); }
  pruneEvents(before: string): Promise<number> { return this.integration.pruneEvents(before); }
  listSubscriptions(): Promise<SubscriptionRecord[]> { return this.integration.listSubscriptions(); }
  getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined> { return this.integration.getSubscription(id); }
  createSubscription(input: NewSubscription): Promise<SubscriptionRecord> { return this.integration.createSubscription(input); }
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined> { return this.integration.updateSubscription(id, patch); }
  deleteSubscription(id: string): Promise<boolean> { return this.integration.deleteSubscription(id); }
  enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number> { return this.integration.enqueueDeliveries(rows, now); }
  claimDeliveries(now: string, limit: number, leaseMs: number, subscriptionId?: string): Promise<DeliveryRecord[]> { return this.integration.claimDeliveries(now, limit, leaseMs, subscriptionId); }
  completeDelivery(id: string, result: DeliveryResult): Promise<boolean> { return this.integration.completeDelivery(id, result); }
  extendLease(id: string, attempt: number, leaseUntil: string): Promise<boolean> { return this.integration.extendLease(id, attempt, leaseUntil); }
  getDelivery(id: string): Promise<DeliveryRecord | undefined> { return this.integration.getDelivery(id); }
  listDeliveries(subscriptionId: string, query?: { status?: DeliveryStatus } & PageQuery): Promise<PageResult<DeliveryRecord>> { return this.integration.listDeliveries(subscriptionId, query); }
  redeliver(id: string, now: string): Promise<boolean> { return this.integration.redeliver(id, now); }
  deliveryStats(): Promise<DeliveryStats[]> { return this.integration.deliveryStats(); }
  pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number> { return this.integration.pruneDeliveries(succeededBefore, deadBefore); }
  getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined> { return this.integration.getServerIntegrationConfig(); }
  putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> { return this.integration.putServerIntegrationConfig(value, expectedRevision); }
  getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined> { return this.integration.getPackageIntegrationConfig(packageId); }
  putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> { return this.integration.putPackageIntegrationConfig(packageId, value, expectedRevision); }
  getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined> { return this.integration.getExternalRefs(packageId); }
  putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>> { return this.integration.putExternalRefs(packageId, doc, expectedRevision); }
  putExternalRefsBatch(items: readonly ExternalRefsBatchItem[]): Promise<Versioned<ExternalRefsDoc>[]> { return this.integration.putExternalRefsBatch(items); }
  findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]> { return this.integration.findExternalRef(system, type, id); }
  listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]> { return this.integration.listExternalRefs(); }
  getRuntimeState(key: string): Promise<unknown | undefined> { return this.integration.getRuntimeState(key); }
  putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> { return this.integration.putRuntimeState(key, value, packageId); }

  // ── Users (2026-10-02) ────────────────────────────────────────────────────
  // Important: login is stored and looked up lowercased — because the table's UNIQUE is case-sensitive.
  //    People treat Kim and kim as the same name, but the table sees them as different.

  async findUserByLogin(login: string): Promise<UserRecord | undefined> {
    const { rows } = await this.client.query<UserRow>(
      `${USER_COLUMNS} WHERE login = $1`,
      [login.trim().toLowerCase()],
    );
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const { rows } = await this.client.query<UserRow>(`${USER_COLUMNS} WHERE id = $1`, [id]);
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.client.query<UserRow>(`${USER_COLUMNS} ORDER BY created_at`);
    return rows.map(toUserRecord);
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    return this.insertUser(this.client, user);
  }

  /** Serializes first-account creation inside this process — see createFirstUser */
  private firstUser: Promise<unknown> = Promise.resolve();

  /**
   * Important: two layers, because each covers what the other cannot. The advisory lock (inside a transaction)
   *    serializes several server instances on one database. The in-process chain is still needed because a single
   *    connection (pg.Client · PGlite) runs both callers' statements in one session, where the advisory lock is
   *    re-entrant and BEGIN does not nest — so it would not keep them apart.
   */
  async createFirstUser(user: NewUser): Promise<UserRecord | undefined> {
    const run = this.firstUser.catch(() => undefined).then(() =>
      withTransaction(this.client, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [FIRST_USER_LOCK_KEY]);
        const { rows } = await tx.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM app_user`);
        if (Number(rows[0]?.n ?? 0) > 0) return undefined;
        return this.insertUser(tx, user);
      }),
    );
    this.firstUser = run;
    return run;
  }

  private async insertUser(client: SqlClient, user: NewUser): Promise<UserRecord> {
    const login = user.login.trim().toLowerCase();
    if (login === '') throw new Error(tr('로그인 이름이 비어 있습니다.'));
    const display = user.displayName.trim() === '' ? login : user.displayName.trim();
    // Important: the id is generated here, not in the DB — it must have the same form as the memory implementation (user_N)
    //    so the conformance tests see both implementations the same way
    const { rows: seq } = await client.query<{ next: string }>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 6) AS integer)), 0) + 1 AS next
         FROM app_user WHERE id ~ '^user_[0-9]+$'`,
    );
    const id = `user_${seq[0]?.next ?? 1}`;
    try {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO app_user (id, login, display_name, role, password_hash, email, company, consent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${USER_FIELDS}`,
        [
          id,
          login,
          display,
          user.role,
          user.passwordHash,
          user.email?.trim() || null,
          user.company?.trim() || null,
          user.consentAt ?? null,
        ],
      );
      return toUserRecord(rows[0]!);
    } catch (caught) {
      // 23505 = unique_violation. Report what happened in plain language
      if ((caught as { code?: string }).code === '23505') {
        throw new Error(fill(tr('이미 있는 로그인 이름입니다: {0}'), { 0: login }));
      }
      throw caught;
    }
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email' | 'company'>>,
  ): Promise<UserRecord | undefined> {
    // Important: change only what is given. Letting undefined flow through COALESCE would wipe out valid values
    const { rows } = await this.client.query<UserRow>(
      `UPDATE app_user SET
         display_name  = COALESCE($2, display_name),
         role          = COALESCE($3, role),
         password_hash = COALESCE($4, password_hash),
         disabled      = COALESCE($5, disabled),
         -- Important: an empty string means "clear it". COALESCE cannot express that, so it is handled separately
         email         = CASE WHEN $6::text IS NULL THEN email
                              WHEN btrim($6::text) = '' THEN NULL
                              ELSE btrim($6::text) END,
         company       = CASE WHEN $7::text IS NULL THEN company
                              WHEN btrim($7::text) = '' THEN NULL
                              ELSE btrim($7::text) END
       WHERE id = $1
       RETURNING ${USER_FIELDS}`,
      [
        id,
        patch.displayName ?? null,
        patch.role ?? null,
        patch.passwordHash ?? null,
        patch.disabled ?? null,
        patch.email ?? null,
        patch.company ?? null,
      ],
    );
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }

  async deleteUser(id: string): Promise<boolean> {
    // Important: identifiable_history does not reference app_user (the foreign key was deliberately dropped in version 4).
    //    So deleting an account does not make "who changed it" disappear with it
    // SqlResult has no rowCount — count via RETURNING, per this store's convention
    const { rows } = await this.client.query<{ id: string }>(
      `DELETE FROM app_user WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async touchUserLogin(id: string): Promise<void> {
    await this.client.query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [id]);
  }

  async countUsers(): Promise<number> {
    const { rows } = await this.client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM app_user`);
    return Number(rows[0]?.n ?? 0);
  }
}

const USER_FIELDS = 'id, login, display_name, role, password_hash, disabled, created_at, last_login_at, email, company, consent_at';
const USER_COLUMNS = `SELECT ${USER_FIELDS}
   FROM app_user`;

interface UserRow {
  id: string;
  login: string;
  display_name: string;
  role: string;
  password_hash: string;
  disabled: boolean;
  created_at: unknown;
  last_login_at: unknown;
  email: string | null;
  company: string | null;
  consent_at: unknown;
}

function toUserRecord(row: UserRow): UserRecord {
  const record: UserRecord = {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    role: row.role as UserRecord['role'],
    passwordHash: row.password_hash,
    disabled: row.disabled,
    createdAt: toIso(row.created_at),
  };
  if (row.last_login_at !== null && row.last_login_at !== undefined) {
    record.lastLoginAt = toIso(row.last_login_at);
  }
  if (row.email) record.email = row.email;
  if (row.company) record.company = row.company;
  if (row.consent_at !== null && row.consent_at !== undefined) record.consentAt = toIso(row.consent_at);
  return record;
}

function checkRevision(options: WriteOptions, actual: number): void {
  if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
    throw new ConflictError(options.expectedRevision, actual);
  }
}

/** Determines whether a next page exists, assuming limit + 1 rows were fetched */
function slicePage<T>(rows: T[], limit: number, keyOf: (item: T) => string): PageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const result: PageResult<T> = { items };
  const last = items[items.length - 1];
  if (hasMore && last !== undefined) result.cursor = keyOf(last);
  return result;
}
