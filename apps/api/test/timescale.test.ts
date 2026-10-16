/**
 * TimescaleDB features for collected values (lead request §6 H2): compression, 1-minute and 1-hour aggregates, chunk
 * drops for retention. The settings and the plain-PostgreSQL path are checked always; the real-database part runs when
 * DATABASE_URL points at a TimescaleDB with the community licence, and is skipped otherwise:
 *
 *     docker run -d --name aas-ts -e POSTGRES_PASSWORD=aas -e POSTGRES_DB=aas -p 55433:5432 \
 *       timescale/timescaledb:latest-pg17 postgres -c max_connections=1000
 *     DATABASE_URL=postgres://postgres:aas@localhost:55433/aas npx vitest run apps/api/test/timescale.test.ts
 */
import { readFileSync } from 'node:fs';

import { readAasx } from '@aas/aasx';
import { HYPERTABLE_SQL, PostgresStore, type CollectedValue, type SqlClient } from '@aas/store';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { rollupWindowDays, setupTimescaleFeatures, timescaleFeaturesFromEnv, type TimescaleFeatures } from '../src/timescale.js';

const url = process.env['DATABASE_URL'];
const DAY = 86_400_000;
const FEATURES: TimescaleFeatures = { compressAfterDays: 7, rollups: true, rollupMinuteDays: 90 };

describe('TimescaleDB feature settings', () => {
  it('defaults: compress after 7 days, aggregates on, 1-minute aggregate kept 90 days; 0 and off turn them off', () => {
    expect(timescaleFeaturesFromEnv({})).toEqual({ compressAfterDays: 7, rollups: true, rollupMinuteDays: 90 });
    expect(timescaleFeaturesFromEnv({ COLLECT_COMPRESS_AFTER_DAYS: '0', COLLECT_ROLLUPS: 'OFF', COLLECT_ROLLUP_MINUTE_DAYS: '0' })).toEqual({
      compressAfterDays: 0,
      rollups: false,
      rollupMinuteDays: 0,
    });
    // Nonsense keeps the default rather than turning a feature off by accident
    expect(timescaleFeaturesFromEnv({ COLLECT_COMPRESS_AFTER_DAYS: '-2', COLLECT_ROLLUP_MINUTE_DAYS: 'lots' })).toMatchObject({ compressAfterDays: 7, rollupMinuteDays: 90 });
  });

  it('the aggregates refresh 35 days back (edge queue 30 days), never past the raw retention', () => {
    expect(rollupWindowDays(0)).toBe(35);
    expect(rollupWindowDays(180)).toBe(35);
    expect(rollupWindowDays(20)).toBe(19);
    expect(rollupWindowDays(0.5)).toBe(1);
  });

  it('on the Apache build nothing is created — one question, one log line', async () => {
    const asked: string[] = [];
    const client: SqlClient = {
      query: async (text) => {
        asked.push(text);
        return { rows: [{ license: 'apache' }] as never[] };
      },
      transaction: async () => {
        throw new Error('not used');
      },
    };
    expect(await setupTimescaleFeatures(client, FEATURES, 180)).toContain('Apache');
    expect(asked).toHaveLength(1);
  });
});

function poolClient(pool: pg.Pool): SqlClient {
  const run = (target: { query: pg.Pool['query'] }) => async (text: string, params?: readonly unknown[]) => ({
    rows: (await target.query(text, params as unknown[])).rows as never[],
  });
  return {
    query: run(pool),
    transaction: async (work) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const outcome = await work({ query: run(connection as unknown as pg.Pool) });
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

let counter = 0;
async function world() {
  const schema = `aas_ts_${Date.now()}_${counter++}`;
  const setup = new pg.Pool({ connectionString: url });
  const { rows } = await setup.query("SELECT current_setting('timescaledb.license', true) AS license");
  await setup.query(`CREATE SCHEMA "${schema}"`);
  await setup.end();
  // Important: public stays in the path — the TimescaleDB functions live there
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  const client = poolClient(pool);
  const store = new PostgresStore(client);
  await store.init();
  // Plain PostgreSQL has no hypertables — the same tests then check that nothing changes there
  if (rows[0]?.license === 'timescale') await client.query(HYPERTABLE_SQL);
  const { id } = await store.importPackage({ name: 'line1.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
  return { pool, client, store, packageId: id, schema, licensed: rows[0]?.license === 'timescale' };
}

/** One value a minute for `hours`, ending `endAgoMs` ago, for properties P1 · P2 — keys as an edge writes them */
const NOW = Date.now();

/** The same arguments always give the same values (a resent batch) */
function series(endAgoMs: number, hours: number, packageId = 'pkg_1', now = NOW): CollectedValue[] {
  const values: CollectedValue[] = [];
  for (let minute = hours * 60; minute > 0; minute -= 1) {
    const at = new Date(now - endAgoMs - minute * 60_000).toISOString();
    for (const property of ['P1', 'P2']) {
      values.push({ packageId, interfaceName: 'OPCUA', propertyName: property, observedAt: at, receivedAt: at, valueNumber: minute % 17, key: `edge:d1:b1:${minute}:${property}` });
    }
  }
  return values;
}

const count = async (client: SqlClient, sql: string, params: unknown[] = []): Promise<number> =>
  Number(((await client.query<{ n: string }>(sql, params)).rows[0] as { n: string }).n);

describe.skipIf(!url)('TimescaleDB features on a real database', () => {
  it('sets up idempotently: compression policy, two aggregates with refresh policies, 1-minute retention', async () => {
    const { pool, client, licensed } = await world();
    try {
      if (!licensed) return;
      expect(await setupTimescaleFeatures(client, FEATURES, 180)).toContain('7');
      expect(await setupTimescaleFeatures(client, { ...FEATURES, compressAfterDays: 3 }, 180)).toContain('3');
      const jobs = await client.query<{ proc_name: string; config: Record<string, unknown> }>(
        "SELECT proc_name, config FROM timescaledb_information.jobs WHERE hypertable_schema = current_schema() OR config->>'mat_hypertable_id' IS NOT NULL",
      );
      const compression = jobs.rows.filter((job) => job.proc_name === 'policy_compression' && job.config['hypertable_id'] !== undefined);
      expect(compression.map((job) => job.config['compress_after'])).toContain('3 days');
      expect(await count(client, "SELECT count(*) AS n FROM timescaledb_information.continuous_aggregates WHERE view_schema = current_schema()")).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('a compressed chunk still refuses a resent value, takes a late new one, and survives a restart and a package delete', async () => {
    const { pool, client, store, packageId } = await world();
    try {
      await store.appendValues(packageId, series(20 * DAY, 2));
      if (!(await setupTimescaleFeatures(client, FEATURES, 180)).includes('7')) return;
      const compressed = await count(client, "SELECT count(*) AS n FROM (SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('collected_value', older_than => INTERVAL '7 days') c) x");
      expect(compressed).toBeGreaterThan(0);
      const before = await count(client, 'SELECT count(*) AS n FROM collected_value');

      // The same batch again (lost answer) adds nothing; a value from another batch at a new time is stored
      await store.appendValues(packageId, series(20 * DAY, 2).slice(0, 10));
      expect(await count(client, 'SELECT count(*) AS n FROM collected_value')).toBe(before);
      const late = series(20 * DAY, 2)[0]!;
      await store.appendValues(packageId, [{ ...late, observedAt: new Date(Date.parse(late.observedAt) + 30_000).toISOString(), key: 'edge:d1:b2:1:0' }]);
      expect(await count(client, 'SELECT count(*) AS n FROM collected_value')).toBe(before + 1);

      // Startup runs the schema again over a compressed hypertable
      await new PostgresStore(client).init();
      expect(await setupTimescaleFeatures(client, FEATURES, 180)).toContain('7');
      await store.deletePackage(packageId);
      expect(await count(client, 'SELECT count(*) AS n FROM collected_value')).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('the aggregates match the raw values (avg · min · max · last · count), compressed chunks included', async () => {
    const { pool, client, store, packageId } = await world();
    try {
      await store.appendValues(packageId, [...series(10 * DAY, 3), ...series(DAY, 3)]);
      if (!(await setupTimescaleFeatures(client, FEATURES, 180)).includes('1')) return;
      await client.query("SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('collected_value', older_than => INTERVAL '7 days') c");
      for (const view of ['collected_value_1m', 'collected_value_1h']) await client.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
      const raw = await client.query(
        `SELECT property_name, time_bucket(INTERVAL '1 hour', observed_at) AS bucket, avg(value_number)::float8 AS avg, min(value_number) AS min,
                max(value_number) AS max, last(value_number, observed_at) AS last, count(*)::int AS samples
           FROM collected_value GROUP BY 1, 2 ORDER BY 1, 2`,
      );
      const hourly = await client.query(
        'SELECT property_name, bucket, avg::float8 AS avg, min, max, last, samples::int AS samples FROM collected_value_1h ORDER BY 1, 2',
      );
      expect(hourly.rows.length).toBeGreaterThan(8);
      expect(hourly.rows).toEqual(raw.rows);
      expect(await count(client, 'SELECT sum(samples) AS n FROM collected_value_1m')).toBe(await count(client, 'SELECT count(*) AS n FROM collected_value'));
    } finally {
      await pool.end();
    }
  });

  it('retention drops whole old chunks but keeps a chunk holding a value received recently', async () => {
    const { pool, client, store, packageId, licensed } = await world();
    try {
      // 30 and 20 days back fall in different chunks (7 days each); the 20-day one can be dropped whole
      await store.appendValues(packageId, [...series(30 * DAY, 2), ...series(20 * DAY, 2), ...series(DAY, 2)]);
      // A constant tag: device time frozen 30 days back, read just now
      const frozen = series(30 * DAY, 1)[0]!;
      await store.appendValues(packageId, [{ ...frozen, propertyName: 'Frozen', receivedAt: new Date().toISOString(), key: 'edge:d1:b9:1:0' }]);
      const chunks = (): Promise<number> => count(client, "SELECT count(*) AS n FROM show_chunks('collected_value')");
      let chunksBefore = 0;
      if (licensed) {
        await setupTimescaleFeatures(client, FEATURES, 180);
        await client.query("SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('collected_value', older_than => INTERVAL '7 days') c");
        chunksBefore = await chunks();
      }
      const total = await count(client, 'SELECT count(*) AS n FROM collected_value');

      const removed = await store.pruneValues(new Date(Date.now() - 10 * DAY).toISOString());
      expect(removed).toBe(2 * 2 * 2 * 60);
      expect(await count(client, 'SELECT count(*) AS n FROM collected_value')).toBe(total - removed);
      expect(await count(client, "SELECT count(*) AS n FROM collected_value WHERE property_name = 'Frozen'")).toBe(1);
      // On TimescaleDB a chunk went as a whole (the frozen value kept its own)
      if (licensed) expect(await chunks()).toBeLessThan(chunksBefore);
    } finally {
      await pool.end();
    }
  });
});
