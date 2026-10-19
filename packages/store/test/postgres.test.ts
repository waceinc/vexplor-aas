/**
 * PostgreSQL implementation tests.
 *
 * This machine has neither Docker nor Postgres, so tests run on **PGlite** (real PostgreSQL compiled to WASM) —
 * a real engine rather than a mock, so DDL/SQL syntax and transaction semantics are verified as is.
 * In production, plug `pg`'s Client/Pool into the same SqlClient slot (no code changes).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readAasx } from '@aas/aasx';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

// Important: PGlite boots a fresh WASM PostgreSQL per test. Running the full suite in parallel pushed this
//    boot past the default 5s and the "lossless round trip" test timed out (passes alone — observed three times on 2026-09-30).
//    It is boot time, not logic, so the timeout is raised generously for this file only
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {
  INTEGRATION_SCHEMA_SQL,
  NotFoundError,
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
    // v9 — integration tables (strip first: their actor_id/actor_name lines would match the v4 patterns below)
    .replace(INTEGRATION_SCHEMA_SQL, '')
    // v2 — bundle attachment role
    .replace(
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle'))",
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra'))",
    )
    // v3 — users table
    .replace(/CREATE TABLE IF NOT EXISTS app_user \([^;]*\);/, '')
    // v6 — workspaces (package owner)
    .replace(/^ *-- *Owner \(workspace key\).*$/m, '')
    .replace(/^ *owner +text$/m, '')
    .replace(/^CREATE INDEX IF NOT EXISTS aas_package_owner_idx.*$/m, '')
    // v5 — sign-up contact info
    .replace(/^ *-- *Contact address \(optional\).*$/m, '')
    .replace(/^ *-- *No UNIQUE either.*$/m, '')
    .replace(/^ *email +text$/m, '')
    // v11 — why a read failed
    .replace(/^ *error +text$/m, '')
    // v10 — idempotency key of collected values (column, the pre-versioning guard and its comment, the unique index)
    .replace(/^ *value_key +text,?$/m, '')
    .replace(/^--.*(DB from before version numbers|value_key yet).*$/gm, '')
    .replace(/^ALTER TABLE collected_value ADD COLUMN IF NOT EXISTS value_key text;$/m, '')
    .replace(/^CREATE UNIQUE INDEX IF NOT EXISTS collected_value_key_idx.*$/m, '')
    // v8 — receivedAt of collected values (a trailing comma once v10 follows it)
    .replace(/^ *received_at +timestamptz,?$/m, '')
    // v4 — the audit trail's "who"; strip its comments too
    .replace(/^ *--.*app_user.*$/m, '')
    .replace(/^ *--.*copied as it was at the time.*$/m, '')
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

  it('v1 tables with no version number at all — SCHEMA_SQL runs before the migrations and must not need later columns', async () => {
    // Found on a real TimescaleDB (2026-10-16): the v10 unique index in SCHEMA_SQL met a collected_value without value_key
    const db = new PGlite();
    for (const statement of V1_SCHEMA.split(';')) if (statement.trim()) await db.query(statement);
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");
    const store = new PostgresStore(clientOf(db));
    await store.init();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await store.getPackage('p1'))?.name).toBe('old.aasx');
  });

  it('v1 DB — migrates to the latest version with data intact', async () => {
    expect(V1_SCHEMA).not.toBe(SCHEMA_SQL);
    // Every later addition is stripped — otherwise the "old DB" is the latest one and no migration line runs
    expect(V1_SCHEMA).not.toMatch(/value_key|received_at|^ *error +text/m);
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
    // v8 and v10 — receivedAt, and a keyed value stored once
    // Dated in the past so the v8 check further down still finds its own value first
    const keyed = { packageId: 'p1', interfaceName: 'I', propertyName: 'P', observedAt: '2020-01-01T00:00:00.000Z', receivedAt: '2020-01-01T00:00:01.000Z', valueNumber: 1, key: 'k1' };
    await store.appendValues('p1', [keyed, keyed]);
    expect((await store.readValues('p1')).map((value) => value.receivedAt)).toEqual(['2020-01-01T00:00:01.000Z']);
    // v11 — the reason of a failed read
    await store.appendValues('p1', [{ packageId: 'p1', interfaceName: 'I', propertyName: 'Q', observedAt: '2019-01-01T00:00:00.000Z', error: 'timeout' }]);
    expect((await store.readValues('p1', { propertyName: 'Q' }))[0]!.error).toBe('timeout');
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
    // v9 — integration tables; every model write above already inserted an event, or it would have failed
    expect((await store.readEvents({ after: 0, limit: 100 })).items.map((event) => event.type)).toContain(
      'kr.vexplor.aas.model.submodel.updated.v1',
    );
    await store.putExternalRefs('p1', { schema: 'vexplor.externalRefs/1', subjects: [] });
    await store.putRuntimeState('k', 1, 'p1');
  });

  it('v8 DB → v9 — integration tables appear, existing data stays; running the upgrade twice is harmless', async () => {
    const db = new PGlite();
    const v8 = SCHEMA_SQL.replace(INTEGRATION_SCHEMA_SQL, '');
    expect(v8).not.toBe(SCHEMA_SQL);
    expect(v8).not.toContain('integration_event');
    for (const statement of v8.split(';')) if (statement.trim()) await db.query(statement);
    await db.query(SCHEMA_VERSION_TABLE);
    await db.query('INSERT INTO schema_version (version) VALUES (8)');
    await db.query("INSERT INTO aas_package (id, name, revision) VALUES ('p1', 'old.aasx', 4)");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    const versions = (await db.query<{ version: number }>('SELECT version FROM schema_version ORDER BY version')).rows;
    expect(versions.map((row) => row.version)).toContain(9);
    await store.createIdentifiable('p1', { modelType: 'Submodel', id: 'urn:x:sm' });
    const [event] = (await store.readEvents({ after: 0, limit: 10 })).items;
    expect(event).toMatchObject({ type: 'kr.vexplor.aas.model.submodel.created.v1', packageRevision: 5 });

    // The same statements once more (idempotent): a second start, and the v9 migration run by hand
    for (const statement of INTEGRATION_SCHEMA_SQL.split(';')) if (statement.trim()) await db.query(statement);
    const again = new PostgresStore(clientOf(db));
    await again.init();
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await again.readEvents({ after: 0, limit: 10 })).items).toHaveLength(1);
    expect((await db.query('SELECT version FROM schema_version')).rows).toHaveLength(versions.length);
  });

  it('v11 DB → v12 — packages stored before keep downloading as 3.0; new ones remember their version', async () => {
    const db = new PGlite();
    const v11 = SCHEMA_SQL.replace(/,\n\s*-- Metamodel version[^\n]*\n[^\n]*\n\s*metamodel_version\s+text,\n\s*metamodel_inferred boolean/, '');
    expect(v11).not.toContain('metamodel_version');
    for (const statement of v11.split(';')) if (statement.trim()) await db.query(statement);
    await db.query(SCHEMA_VERSION_TABLE);
    await db.query('INSERT INTO schema_version (version) VALUES (11)');
    await db.query("INSERT INTO aas_package (id, name, revision) VALUES ('p1', 'old.aasx', 2)");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await store.getPackage('p1'))?.metamodel).toEqual({ version: '3.0', inferred: true });
    const golden = readAasx(new Uint8Array(readFileSync(fileURLToPath(new URL('../../../tests/fixtures/01-roll-forming-machine.aasx', import.meta.url)))));
    const made = await store.importPackage({ name: 'new.aasx', package: golden, metamodel: { version: '3.1', inferred: false } });
    expect((await store.getPackage(made.id))?.metamodel).toEqual({ version: '3.1', inferred: false });
    // Running the upgrade again is harmless
    const again = new PostgresStore(clientOf(db));
    await again.init();
    expect((await again.getPackage(made.id))?.metamodel).toEqual({ version: '3.1', inferred: false });
  });

  it('the v9 script has no semicolon inside a comment or a string — statements are split on it', () => {
    for (const statement of INTEGRATION_SCHEMA_SQL.split(';')) {
      const sql = statement.trim();
      if (sql === '') continue;
      expect(sql).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
      expect(sql).not.toMatch(/--/);
    }
  });

  it('a DB exactly one version ahead is refused too (v10 for this v9 program)', async () => {
    const db = new PGlite();
    await new PostgresStore(clientOf(db)).init();
    await db.query('INSERT INTO schema_version (version) VALUES ($1)', [SCHEMA_VERSION + 1]);
    const later = new PostgresStore(clientOf(db));
    await expect(later.init()).rejects.toBeInstanceOf(SchemaVersionError);
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

describe('collected values — one batch, one transaction (2.8.1)', () => {
  const golden = readAasx(new Uint8Array(readFileSync(fileURLToPath(new URL('../../../tests/fixtures/01-roll-forming-machine.aasx', import.meta.url)))));
  const values = (packageId: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      packageId,
      interfaceName: 'InterfaceOPCUA',
      propertyName: `Tag${index % 7}`,
      source: index % 2 === 0 ? `ns=2;s=T${index}` : undefined,
      observedAt: new Date(Date.UTC(2026, 9, 18, 0, 0, 0, index)).toISOString(),
      receivedAt: index % 3 === 0 ? undefined : new Date(Date.UTC(2026, 9, 18, 0, 0, 1, index)).toISOString(),
      ...(index % 5 === 0 ? { valueText: `text ${index}` } : { valueNumber: index + 0.25 }),
      ...(index % 11 === 0 ? { quality: 'Good' } : {}),
      ...(index % 13 === 0 ? { error: 'IllegalDataAddress' } : {}),
      key: `edge:dev:boot:1:${index}`,
    }));

  /** Counts the statements that insert collected values — before 2.8.1 it was one per value */
  function counting(db: PGlite) {
    const seen = { inserts: 0 };
    const client: SqlClient = {
      async query(text, params) {
        if (/INSERT INTO collected_value/.test(text)) seen.inserts += 1;
        return { rows: (await db.query(text, params as unknown[])).rows as never[] };
      },
    };
    return { client, seen };
  }

  it('a batch of 5,000 values is one INSERT, and every column reads back as written', async () => {
    const db = new PGlite();
    const { client, seen } = counting(db);
    const store = new PostgresStore(client);
    await store.init();
    const { id } = await store.importPackage({ name: 'line.aasx', package: golden });
    const batch = values(id, 5_000);
    await store.appendValues(id, batch);
    expect(seen.inserts).toBe(1);
    const back = await store.readValues(id, { limit: 10_000 });
    expect(back).toHaveLength(5_000);
    const byTime = new Map(back.map((value) => [value.observedAt, value]));
    for (const sent of batch) {
      const { key: _key, ...expected } = sent;
      const got = byTime.get(sent.observedAt)!;
      expect(got).toEqual(Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== undefined)));
    }
    // The same batch again stores nothing twice (keys), and still in one statement
    await store.appendValues(id, batch);
    expect(seen.inserts).toBe(2);
    expect(await store.readValues(id, { limit: 20_000 })).toHaveLength(5_000);
  });

  it('a value that cannot be stored stops the whole batch — nothing of it is kept', async () => {
    const db = new PGlite();
    const store = new PostgresStore(clientOf(db));
    await store.init();
    const { id } = await store.importPackage({ name: 'line.aasx', package: golden });
    const batch = values(id, 10);
    batch[6] = { ...batch[6]!, observedAt: 'not a time' };
    await expect(store.appendValues(id, batch)).rejects.toThrow();
    expect(await store.readValues(id)).toEqual([]);
  });

  it('a value for a file that is gone is "not found", as before', async () => {
    const store = await freshStore();
    await store.init();
    await expect(store.appendValues('pkg_gone', values('pkg_gone', 2))).rejects.toBeInstanceOf(NotFoundError);
  });
});
