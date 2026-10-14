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
import { PostgresStore, type SqlClient } from '@aas/store';
import pg from 'pg';
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
async function freshStore(): Promise<PostgresStore> {
  const pool = new pg.Pool({ connectionString: url });
  const schema = `aas_test_${Date.now()}_${counter++}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`SET search_path TO "${schema}"`);
  // Make every pooled connection see the same schema
  pool.on('connect', (client) => void client.query(`SET search_path TO "${schema}"`));
  const store = new PostgresStore(poolClient(pool));
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
