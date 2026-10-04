/**
 * PostgreSQL 저장소.
 *
 * 드라이버를 직접 의존하지 않고 `SqlClient` 포트만 받는다 — `pg`(운영)와
 * `@electric-sql/pglite`(테스트·개발) 양쪽이 같은 모양이라 그대로 꽂힌다.
 * 덕분에 이 패키지는 런타임 의존성이 0이고, 라이선스 검토 대상도 늘지 않는다.
 *
 * bytea는 hex 문자열로 주고받는다(`decode($n,'hex')` / `encode(data,'hex')`).
 * 드라이버마다 바이너리 바인딩 규약이 달라(Buffer 전용인 pg vs Uint8Array인 pglite)
 * 이식성을 택했다. 🔴 수백 MB 매뉴얼을 넣게 되면 메모리를 두 배로 쓰므로,
 * 그때는 드라이버 고유 바이너리 바인딩으로 갈아탄다(기획서 Ⅷ 대용량 파일 항목).
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
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

const DEFAULT_LIMIT = 100;

export interface SqlResult<R> {
  rows: R[];
}

/** 드라이버가 만족해야 하는 최소 모양 */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<R>>;
  /**
   * 원자적 실행. `pg.Pool`처럼 질의마다 연결이 달라지는 클라이언트는 **반드시 제공해야 한다**
   * (BEGIN이 다른 연결로 가면 트랜잭션이 성립하지 않는다).
   * 단일 연결(pg.Client · PGlite)이면 생략해도 된다.
   */
  transaction?<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** 스키마 판 확인용 자문 잠금 키 — 다른 용도와 겹치지 않는 임의의 값 */
const SCHEMA_LOCK_KEY = 0x00aa5501;

/** DB 스키마가 프로그램보다 새롭다 — 기동을 거부한다 */
export class SchemaVersionError extends Error {
  constructor(
    message: string,
    readonly found: number,
  ) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

async function withTransaction<T>(client: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
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

const HEX = '0123456789abcdef';

function toHex(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

function fromHex(value: string): Uint8Array {
  // pg는 bytea를 '\x...' 형태로 돌려주기도 한다
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
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
    // 🔴 NULL은 키를 빼고 돌려준다 — 메모리 저장소와 모양이 같아야 대조 시험이 선다
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
    // jsonb는 드라이버가 이미 객체로 준다. 문자열로 오는 드라이버도 있어 한 번 더 본다
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

export class PostgresStore implements AasStore {
  constructor(private readonly client: SqlClient) {}

  /** 기동 때 확인한 DB 스키마 판. init() 전에는 undefined */
  schemaVersion: number | undefined;

  async init(): Promise<void> {
    await this.runStatements(SCHEMA_VERSION_SQL);
    // 🔴 판 확인·올림은 한 트랜잭션 + 자문 잠금 안에서 — 두 인스턴스가 동시에 떠도 한 번만 적용된다
    this.schemaVersion = await withTransaction(this.client, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      const { rows } = await tx.query<{ version: number | string | null }>(
        'SELECT max(version) AS version FROM schema_version',
      );
      const found = rows[0]?.version;
      let current = found === null || found === undefined ? 0 : Number(found);

      if (current > SCHEMA_VERSION) {
        throw new SchemaVersionError(
          `DB 스키마가 ${current}판인데 이 프로그램은 ${SCHEMA_VERSION}판까지만 압니다 — ` +
            '프로그램을 판올림하십시오. 옛 프로그램이 새 표를 읽으면 조용히 잃을 수 있어 기동하지 않습니다.',
          current,
        );
      }
      if (current === 0) {
        // 빈 DB이거나 판 번호 도입 전의 DB. SCHEMA_SQL(IF NOT EXISTS)은 **이미 있는 표를 고치지 않는다** —
        // 1판 표의 제약이 그대로 남는다. 그래서 마이그레이션(멱등)을 전부 한 번 더 돌린다(2판 도입 때 발견)
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
      // 판이 같아도 SCHEMA_SQL은 멱등이라 한 번 더 돌려 빠진 색인 등을 채운다
      await this.runStatements(SCHEMA_SQL, tx);
      return current;
    });
  }

  /** 여러 문장을 한 번에 보내지 못하는 드라이버가 있어 문장 단위로 나눠 보낸다 */
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
    if (!row) throw new NotFoundError(`패키지 ${packageId}`);
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
    // id 중복(KOSMO-CD-5 결함)이 실제로 들어온다. 먼저 나온 것을 대표로 본다
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
      if (!row) throw new InvalidContentError('패키지를 만들지 못했습니다.');

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
    // 수집은 모델을 바꾸지 않는다 — 패키지 리비전을 올리지 않는다(A안)
    for (const value of values) {
      await this.client.query(
        `INSERT INTO collected_value
           (package_id, interface_name, property_name, source, observed_at, value_number, value_text, quality)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
        [
          packageId,
          value.interfaceName,
          value.propertyName,
          value.source ?? null,
          value.observedAt,
          value.valueNumber ?? null,
          value.valueText ?? null,
          value.quality ?? null,
        ],
      );
    }
  }

  async pruneValues(before: string): Promise<number> {
    // SqlResult에 rowCount가 없으니 RETURNING으로 센다. 하이퍼테이블에서도 그대로 동작한다
    // (drop_chunks가 더 싸지만 TimescaleDB 없는 배포와 코드를 나누지 않는다)
    const { rows } = await this.client.query<{ n: number }>(
      'DELETE FROM collected_value WHERE observed_at < $1::timestamptz RETURNING 1 AS n',
      [before],
    );
    return rows.length;
  }

  async readValues(packageId: string, query: ValueQuery = {}): Promise<CollectedValue[]> {
    // 없는 패키지는 빈 목록이 아니라 NotFound다 — 인메모리 구현과 같아야 한다(적합성 시험)
    await this.requirePackage(packageId);
    const { rows } = await this.client.query<{
      interface_name: string;
      property_name: string;
      source: string | null;
      observed_at: unknown;
      value_number: number | null;
      value_text: string | null;
      quality: string | null;
    }>(
      `SELECT interface_name, property_name, source, observed_at, value_number, value_text, quality
       FROM collected_value
       WHERE package_id = $1
         AND ($2::text IS NULL OR interface_name = $2)
         AND ($3::text IS NULL OR property_name = $3)
         AND ($4::timestamptz IS NULL OR observed_at >= $4)
         AND ($5::timestamptz IS NULL OR observed_at < $5)
       ORDER BY observed_at DESC
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
    await this.requirePackage(packageId);
    await this.client.query(
      `INSERT INTO aas_package_file (package_id, part, role, content_type, data)
       VALUES ($1, $2, $3, $4, decode($5, 'hex'))
       ON CONFLICT (package_id, part)
       DO UPDATE SET role = EXCLUDED.role, content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
      [packageId, file.part, file.role, file.contentType, toHex(file.data)],
    );
    await this.touch(this.client, packageId);
  }

  async deletePackageFile(packageId: string, part: string): Promise<void> {
    const { rows } = await this.client.query<{ part: string }>(
      'DELETE FROM aas_package_file WHERE package_id = $1 AND part = $2 RETURNING part',
      [packageId, part],
    );
    if (rows.length === 0) throw new NotFoundError(`파트 ${part}`);
    await this.touch(this.client, packageId);
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
    // 🔴 거르는 조건이 LIMIT **안쪽**에 있어야 한다 — 받아 와서 밖에서 거르면 한 쪽이 덜 찬다
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
    const { rows } = await this.client.query<{ id: string }>(
      'DELETE FROM aas_package WHERE id = $1 RETURNING id',
      [packageId],
    );
    if (rows.length === 0) throw new NotFoundError(`패키지 ${packageId}`);
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
    // 필터는 전부 파생 컬럼이라 인덱스를 탄다. NULL이면 조건이 통째로 참이 된다
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
        throw new InvalidContentError(`이미 있는 id입니다: ${d.id}`);
      }
      // 자리를 지정하면 그 자리에(COALESCE), 아니면 맨 뒤에
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
      return toIdentifiableRecord(rows[0]!);
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
        `본문의 modelType·id가 경로와 다릅니다: ${d.modelType} ${d.id}. ` +
          'id를 바꾸려면 참조 무결성 때문에 Quick Fix의 교정 경로를 쓰십시오.',
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
      return toIdentifiableRecord(rows[0]!);
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
    });
  }

  private async pushHistory(
    tx: SqlClient,
    row: IdentifiableRow,
    operation: 'update' | 'delete',
    explicitActor?: Actor,
  ): Promise<void> {
    // 「누가」 — 명시가 없으면 요청 문맥에서. 없으면 NULL(로그인을 안 쓰는 서버)
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
      // 🔴 null은 키를 빼고 돌려준다 — 메모리 저장소와 모양이 같아야 대조 시험이 선다
      ...(r.actor_id === null ? {} : { actorId: r.actor_id }),
      ...(r.actor_name === null ? {} : { actorName: r.actor_name }),
    }));
  }

  // ── 사용자 (2026-10-02) ───────────────────────────────────────────────────
  // 🔴 login은 소문자로 맞춰 넣고 찾는다 — 표의 UNIQUE가 대소문자를 가리기 때문이다.
  //    사람은 Kim과 kim을 같은 이름으로 여기는데 표는 다른 것으로 본다.

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
    const login = user.login.trim().toLowerCase();
    if (login === '') throw new Error('로그인 이름이 비어 있습니다.');
    const display = user.displayName.trim() === '' ? login : user.displayName.trim();
    // 🔴 id를 DB에서 만들지 않고 여기서 짓는다 — 메모리 구현과 같은 꼴(user_N)이어야
    //    적합성 테스트가 두 구현을 같은 눈으로 본다
    const { rows: seq } = await this.client.query<{ next: string }>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 6) AS integer)), 0) + 1 AS next
         FROM app_user WHERE id ~ '^user_[0-9]+$'`,
    );
    const id = `user_${seq[0]?.next ?? 1}`;
    try {
      const { rows } = await this.client.query<UserRow>(
        `INSERT INTO app_user (id, login, display_name, role, password_hash, email)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, login, display_name, role, password_hash, disabled, created_at, last_login_at, email`,
        [id, login, display, user.role, user.passwordHash, user.email?.trim() || null],
      );
      return toUserRecord(rows[0]!);
    } catch (caught) {
      // 23505 = unique_violation. 무슨 일인지 사람 말로 돌려준다
      if ((caught as { code?: string }).code === '23505') {
        throw new Error(`이미 있는 로그인 이름입니다: ${login}`);
      }
      throw caught;
    }
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email'>>,
  ): Promise<UserRecord | undefined> {
    // 🔴 준 것만 바꾼다. COALESCE로 undefined를 흘리면 멀쩡한 값이 지워진다
    const { rows } = await this.client.query<UserRow>(
      `UPDATE app_user SET
         display_name  = COALESCE($2, display_name),
         role          = COALESCE($3, role),
         password_hash = COALESCE($4, password_hash),
         disabled      = COALESCE($5, disabled),
         -- 🔴 빈 문자열은 「지우라」는 뜻이다. COALESCE로는 그 뜻을 낼 수 없어 따로 쓴다
         email         = CASE WHEN $6::text IS NULL THEN email
                              WHEN btrim($6::text) = '' THEN NULL
                              ELSE btrim($6::text) END
       WHERE id = $1
       RETURNING id, login, display_name, role, password_hash, disabled, created_at, last_login_at, email`,
      [
        id,
        patch.displayName ?? null,
        patch.role ?? null,
        patch.passwordHash ?? null,
        patch.disabled ?? null,
        patch.email ?? null,
      ],
    );
    return rows[0] ? toUserRecord(rows[0]) : undefined;
  }

  async deleteUser(id: string): Promise<boolean> {
    // 🔴 identifiable_history는 app_user를 참조하지 않는다(4판에서 일부러 외래키를 뺐다).
    //    그래서 계정을 지워도 「누가 바꿨나」가 함께 사라지지 않는다
    // SqlResult에 rowCount가 없다 — 이 저장소의 관례대로 RETURNING으로 센다
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

const USER_COLUMNS = `SELECT id, login, display_name, role, password_hash, disabled, created_at, last_login_at, email
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
  return record;
}

function checkRevision(options: WriteOptions, actual: number): void {
  if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
    throw new ConflictError(options.expectedRevision, actual);
  }
}

/** limit + 1건을 받아 왔다는 전제로 다음 쪽 유무를 판정한다 */
function slicePage<T>(rows: T[], limit: number, keyOf: (item: T) => string): PageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const result: PageResult<T> = { items };
  const last = items[items.length - 1];
  if (hasMore && last !== undefined) result.cursor = keyOf(last);
  return result;
}
