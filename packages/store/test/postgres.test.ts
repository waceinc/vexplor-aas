/**
 * PostgreSQL implementation tests.
 *
 * This machine has neither Docker nor Postgres, so tests run on **PGlite** (real PostgreSQL compiled to WASM) —
 * a real engine rather than a mock, so DDL/SQL syntax and transaction semantics are verified as is.
 * In production, plug `pg`'s Client/Pool into the same SqlClient slot (no code changes).
 */
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

// Important: PGlite boots a fresh WASM PostgreSQL per test. Running the full suite in parallel pushed this
//    boot past the default 5s and the "lossless round trip" test timed out (passes alone — observed three times on 2026-09-30).
//    It is boot time, not logic, so the timeout is raised generously for this file only
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {
  PostgresStore,
  runAsActor,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  SCHEMA_VERSION_SQL as SCHEMA_VERSION_TABLE,
  SchemaVersionError,
  type SqlClient,
} from '@aas/store';
import { describeStore, describeStoreFilters } from './conformance.js';

function clientOf(db: PGlite): SqlClient {
  return {
    async query(text, params) {
      const result = await db.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
  };
}

/** Boots a new PGlite instance each time — tests must not share state */
async function freshStore(): Promise<PostgresStore> {
  return new PostgresStore(clientOf(new PGlite()));
}

describeStore('PostgresStore (PGlite)', freshStore);
describeStoreFilters('PostgresStore (PGlite)', freshStore);

describe('schema version number (schema_version)', () => {
  it('empty DB — creates the latest version and records its number; same number on restart', async () => {
    const db = new PGlite();
    const first = new PostgresStore(clientOf(db));
    await first.init();
    expect(first.schemaVersion).toBe(SCHEMA_VERSION);
    const rows = (await db.query<{ version: number }>('SELECT version FROM schema_version')).rows;
    expect(rows.map((r) => r.version)).toEqual([SCHEMA_VERSION]);

    const second = new PostgresStore(clientOf(db));
    await second.init();
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await db.query('SELECT version FROM schema_version')).rows).toHaveLength(1);
  });

  it('DB from before versioning — existing tables are treated as v1; data is kept and only the number is recorded', async () => {
    const db = new PGlite();
    for (const statement of SCHEMA_SQL.split(';')) if (statement.trim()) await db.query(statement);
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await store.getPackage('p1'))?.name).toBe('old.aasx');
  });

  /**
   * **Reconstructs** the v1 tables — strips everything added in later versions.
   *
   * Important: if a removal is missed, this test silently becomes useless. The "old DB" is really the latest schema,
   *    so it passes without running a single migration line — this actually happened with v3 (app_user)
   *    on 2026-10-02. When bumping the version, **strip it here too**.
   */
  const V1_SCHEMA = SCHEMA_SQL
    // v2 — bundle attachment role
    .replace(
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle'))",
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra'))",
    )
    // v3 — users table
    .replace(/CREATE TABLE IF NOT EXISTS app_user \([^;]*\);/, '')
    // v6 — workspaces (package owner)
    .replace(/^ *-- *주인\(작업 공간 열쇠\).*$/m, '')
    .replace(/^ *owner +text$/m, '')
    .replace(/^CREATE INDEX IF NOT EXISTS aas_package_owner_idx.*$/m, '')
    // v5 — sign-up contact info
    .replace(/^ *-- *연락처\(선택\).*$/m, '')
    .replace(/^ *-- *UNIQUE도 걸지 않는다.*$/m, '')
    .replace(/^ *email +text$/m, '')
    // v8 — receivedAt of collected values
    .replace(/^ *received_at +timestamptz$/m, '')
    // v4 — the audit trail's "who"; strip its comments too
    .replace(/^ *--.*app_user.*$/m, '')
    .replace(/^ *--.*그때의 것을 베껴.*$/m, '')
    .replace(/^ *actor_id +text,$/m, '')
    .replace(/^ *actor_name +text$/m, '')
    // The above leaves blank lines and a trailing comma — restore what follows `changed_at ...,`
    .replace(/,\s*\)\s*;/g, '\n);');

  const bundleFile = {
    part: '/bundle/01_UseCase문서/a.docx',
    role: 'bundle' as const,
    contentType: 'application/octet-stream',
    data: new Uint8Array([1]),
  };

  it('v1 DB — migrates to the latest version with data intact', async () => {
    expect(V1_SCHEMA).not.toBe(SCHEMA_SQL);
    const db = new PGlite();
    for (const statement of V1_SCHEMA.split(';')) if (statement.trim()) await db.query(statement);
    await db.query(SCHEMA_VERSION_TABLE);
    await db.query('INSERT INTO schema_version (version) VALUES (1)');
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    // Important: do not hard-code the version number — if this test broke on every bump it would
    //    only report that the version changed, never check that the migration **actually happened**
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    await store.putPackageFile('p1', bundleFile);     // v2 — bundle attachment
    expect((await store.packageFiles('p1')).map((f) => f.role)).toEqual(['bundle']);
    // v3 — users table; it must appear in old DBs too or login cannot work
    expect(await store.countUsers()).toBe(0);
    const made = await store.createUser({
      login: 'admin', displayName: '관리자', role: 'admin', passwordHash: 'h',
    });
    expect((await store.findUserByLogin('admin'))?.id).toBe(made.id);
    // v4 — the history's "who"; without the columns the INSERT fails outright
    await store.createIdentifiable('p1', {
      modelType: 'Submodel',
      id: 'urn:x:sm',
      idShort: '처음',
    });
    await runAsActor({ id: made.id, name: '관리자' }, async () => {
      await store.updateIdentifiable('p1', 'Submodel', 'urn:x:sm', {
        modelType: 'Submodel',
        id: 'urn:x:sm',
        idShort: '고침',
      });
    });
    const history = await store.history('p1', 'Submodel', 'urn:x:sm');
    expect(history[0]?.actorName).toBe('관리자');
    // v6 — workspaces. Important: old packages **stay shared** — everyone still sees them after migration
    expect((await store.getPackage('p1'))?.owner).toBeUndefined();
    const seen = await store.listPackages({}, { owner: 'user:아무나' });
    expect(seen.items.map((item) => item.id)).toContain('p1');
    // The index lives in the migration, not the table definition — check it was not lost in the move
    const index = await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'aas_package_owner_idx'");
    expect(index.rows).toHaveLength(1);
    // v7 — company name and consent time; without the columns sign-up fails outright
    const member = await store.createUser({
      login: 'kim', displayName: '김', role: 'editor', passwordHash: 'h', company: 'WACE', consentAt: '2026-10-06T07:00:00.000Z',
    });
    expect((await store.getUser(member.id))?.company).toBe('WACE');
    // v8 — receivedAt of collected values; without the column collection fails outright
    await store.appendValues('p1', [
      {
        packageId: 'p1',
        interfaceName: 'I',
        propertyName: 'Speed',
        observedAt: '2026-10-13T00:00:00.000Z',
        receivedAt: '2026-10-13T00:05:00.000Z',
        valueNumber: 1,
      },
    ]);
    expect((await store.readValues('p1'))[0]?.receivedAt).toBe('2026-10-13T00:05:00.000Z');
  });

  it('v1 tables from before versioning get their constraints migrated too — IF NOT EXISTS alone does not fix them', async () => {
    const db = new PGlite();
    for (const statement of V1_SCHEMA.split(';')) if (statement.trim()) await db.query(statement);
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    await store.putPackageFile('p1', bundleFile);
    expect((await store.packageFiles('p1')).map((f) => f.role)).toEqual(['bundle']);
  });

  it('refuses to start when the DB is newer than the program — better than silently losing data', async () => {
    const db = new PGlite();
    const store = new PostgresStore(clientOf(db));
    await store.init();
    await db.query('INSERT INTO schema_version (version) VALUES ($1)', [SCHEMA_VERSION + 5]);

    const later = new PostgresStore(clientOf(db));
    await expect(later.init()).rejects.toBeInstanceOf(SchemaVersionError);
    await expect(later.init()).rejects.toThrow(/판올림/);
    expect(later.schemaVersion).toBeUndefined();
  });
});
