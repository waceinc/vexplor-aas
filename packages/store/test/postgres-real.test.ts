/**
 * Real PostgreSQL cross-check — verifies the production path.
 *
 * PGlite (WASM) is the same PostgreSQL engine but **a different driver.**
 * Production uses `pg`, and some things diverge there —
 * type conversion (bigint, timestamptz, jsonb), transactions over a connection pool, bytea encoding.
 * So the same conformance suite runs once more against a **real server + the pg driver**.
 *
 * Skipped entirely when no server is available — missing infrastructure is no reason to block other tests.
 *   docker run -d --name aas-pg -e POSTGRES_PASSWORD=aas -e POSTGRES_DB=aas \
 *     -p 55432:5432 timescale/timescaledb:latest-pg17
 *   DATABASE_URL=postgres://postgres:aas@localhost:55432/aas npx vitest run packages/store
 */
import { ConflictError, PostgresStore, type SqlClient } from '@aas/store';
import pg from 'pg';
import { settledPrefix } from '../../../apps/api/src/integration/ids.js';
import { describe, expect, it } from 'vitest';
import { describeStore, describeStoreFilters } from './conformance.js';

const url = process.env['DATABASE_URL'];

/**
 * pg.Pool may use a different connection per query — if BEGIN lands on another connection there is no transaction.
 * Hence `transaction` must always be provided (why the port requires it).
 */
function poolClient(pool: pg.Pool): SqlClient {
  return {
    query: async (text, params) => {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
    transaction: async (work) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const outcome = await work({
          query: async (text, params) => {
            const result = await connection.query(text, params as unknown[]);
            return { rows: result.rows as never[] };
          },
        });
        await connection.query('COMMIT');
        return outcome;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

/** Creates a fresh schema per test — never rely on leftovers from a previous test */
let counter = 0;
async function freshPool(): Promise<pg.Pool> {
  const schema = `aas_test_${Date.now()}_${counter++}`;
  // Important: the search_path goes into the connection options, so it holds on every pooled connection from its first
  //    query on. Setting it in a 'connect' handler races the first query of a fresh connection (two concurrent claims
  //    each opened one and one of them ran against the default schema)
  const setup = new pg.Pool({ connectionString: url });
  await setup.query(`CREATE SCHEMA "${schema}"`);
  await setup.end();
  return new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
}

async function freshStore(): Promise<PostgresStore> {
  const store = new PostgresStore(poolClient(await freshPool()));
  await store.init();
  return store;
}

if (!url) {
  describe.skip('real PostgreSQL (no DATABASE_URL — skipped)', () => {
    it('skipped', () => undefined);
  });
} else {
  describeStore('PostgresStore (진짜 pg)', freshStore);
  describeStoreFilters('PostgresStore (진짜 pg)', freshStore);

  describe('integration — behaviour that needs real concurrent connections', () => {
    it('out-of-order commit: a later seq becomes visible first, and settledPrefix holds the cursor until the gap fills', async () => {
      const pool = await freshPool();
      const store = new PostgresStore(poolClient(pool));
      await store.init();
      const event = (id: string) => ({ id, type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:00.000Z', data: {} });
      const slow = await pool.connect();
      try {
        await slow.query('BEGIN');
        // The slow transaction takes its seq first...
        await slow.query(
          "INSERT INTO integration_event (id, type, occurred_at, data) VALUES ('slow', 'kr.vexplor.aas.equipment.state.changed.v1', now(), '{}'::jsonb)",
        );
        // ...and a fast one commits a higher seq meanwhile
        const [fast] = await store.appendEvents([event('fast')]);
        const visible = (await store.readEvents({ after: 0, limit: 10 })).items;
        expect(visible.map((row) => row.id)).toEqual(['fast']);
        expect(fast!.seq).toBeGreaterThan(1);
        // A young gap holds the consumer at its cursor — advancing to `fast` would lose `slow` for good
        expect(settledPrefix(visible, 0, Date.parse(fast!.recordedAt) + 1000)).toEqual([]);
        await slow.query('COMMIT');
      } finally {
        slow.release();
      }
      const all = (await store.readEvents({ after: 0, limit: 10 })).items;
      expect(all.map((row) => row.id)).toEqual(['slow', 'fast']);
      expect(settledPrefix(all, 0, Date.now()).map((row) => row.id)).toEqual(['slow', 'fast']);
      await pool.end();
    });

    it('two dispatchers claiming at once never get the same delivery (SKIP LOCKED)', async () => {
      const pool = await freshPool();
      const a = new PostgresStore(poolClient(pool));
      await a.init();
      const b = new PostgresStore(poolClient(pool));
      const sub = await a.createSubscription({
        name: 'S', kind: 'webhook', url: 'https://x.example.com', types: ['*'], packageIds: [], enabled: true, options: {}, secretHint: 'aaaa',
        secrets: { keyId: 'k', secretSealed: 's' },
      });
      const now = '2026-10-14T00:00:00.000Z';
      await a.enqueueDeliveries(Array.from({ length: 50 }, (_, n) => ({ subscriptionId: sub.id, eventSeq: n + 1, eventId: `e${n}` })), now);
      const batches = await Promise.all(Array.from({ length: 6 }, (_, n) => (n % 2 === 0 ? a : b).claimDeliveries(now, 10, 60_000)));
      const ids = batches.flat().map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(50);
      await pool.end();
    });
  });

  describe('integration — review fixes that need concurrent connections', () => {
    it('two first writes of one package\'s refs race: with revision 0 one wins and the other gets ConflictError, never a raw 23505', async () => {
      const pool = await freshPool();
      const store = new PostgresStore(poolClient(pool));
      await store.init();
      const doc = (id: string) => ({ schema: 'vexplor.externalRefs/1' as const, subjects: [{ subject: { kind: 'asset' as const, globalAssetId: 'urn:g' }, refs: [{ system: 's', type: 't', id }] }] });
      for (let round = 0; round < 5; round++) {
        const target = (await store.importPackage({ name: `r${round}.aasx`, package: { environment: {}, specPart: '/aasx/data.json', supplementaryFiles: [], extraParts: new Map() } })).id;
        const results = await Promise.allSettled([store.putExternalRefs(target, doc(`a${round}`), 0), store.putExternalRefs(target, doc(`b${round}`), 0)]);
        const ok = results.filter((result) => result.status === 'fulfilled');
        const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.reason).toBeInstanceOf(ConflictError);
        // Without an expected revision both succeed, one after the other
        const both = await Promise.all([store.putExternalRefs(target, doc(`c${round}`)), store.putExternalRefs(target, doc(`d${round}`))]);
        expect(both.map((item) => item.revision).sort()).toEqual([2, 3]);
      }
      await pool.end();
    });

    it('a duplicate append leaves no gap in seq on real PostgreSQL either', async () => {
      const store = await freshStore();
      const event = (id: string) => ({ id, type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:00.000Z', data: {} });
      const [a] = await store.appendEvents([event('a')]);
      await store.appendEvents([event('a')]);
      await Promise.all([store.appendEvents([event('a')]), store.appendEvents([event('a')])]);
      const [b] = await store.appendEvents([event('b')]);
      expect(b!.seq).toBe(a!.seq + 1);
    });
  });

  describe('issues that surface only in production', () => {
    it('withstands pg driver type conversion — bigint, timestamptz, jsonb', async () => {
      const store = await freshStore();
      const record = await store.importPackage({
        name: '타입시험.aasx',
        package: {
          environment: {
            submodels: [
              {
                modelType: 'Submodel',
                id: 'https://x/sm/1/0',
                idShort: 'Test',
                kind: 'Template',
              } as never,
            ],
          },
          specPart: '/aasx/data.json',
          supplementaryFiles: [],
          extraParts: new Map(),
        },
      });

      const submodel = (await store.listIdentifiables(record.id, 'Submodel')).items[0]!;
      // pg returns bigserial as a string — our records must expose a string uid
      expect(typeof submodel.uid).toBe('string');
      // timestamptz arrives as a Date, but we return an ISO string
      expect(submodel.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      // jsonb comes back as an object
      expect(submodel.content['idShort']).toBe('Test');
    });

    it('converts the collected-value table to a hypertable when TimescaleDB is present', async () => {
      const store = await freshStore();
      const pool = new pg.Pool({ connectionString: url });
      try {
        const extension = await pool.query(
          "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
        );
        if (extension.rowCount === 0) return; // Skip on plain PostgreSQL

        // The schema name is unknown here, so create one directly on a new connection and test there
        const schema = `ts_test_${Date.now()}`;
        await pool.query(`CREATE SCHEMA "${schema}"`);
        const { SCHEMA_SQL, HYPERTABLE_SQL } = await import('@aas/store');
        for (const statement of SCHEMA_SQL.split(';')) {
          const sql = statement.trim();
          // Important: dropping public from search_path hides TimescaleDB functions (create_hypertable).
          // Deployments using our own schema hit the same trap, so mirror that setup here
          if (sql) await pool.query(`SET search_path TO "${schema}", public; ${sql}`);
        }
        await pool.query(`SET search_path TO "${schema}", public; ${HYPERTABLE_SQL}`);

        const hypertables = await pool.query(
          "SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema = $1",
          [schema],
        );
        expect(hypertables.rows.map((r) => r['hypertable_name'])).toContain('collected_value');
      } finally {
        await pool.end();
      }
      expect(store).toBeDefined();
    });
  });
}
