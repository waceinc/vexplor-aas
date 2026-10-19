/**
 * PostgreSQL connection for production.
 *
 * `@aas/store` does not depend on a driver and only takes a `SqlClient` port (to avoid adding license reviews).
 * This is where that port is filled in with `pg` (MIT). **Dynamic import** is used so that
 * deployments started without `DATABASE_URL` (demo/dev) never load the driver at all.
 *
 * Important: `pg.Pool` uses a different connection per query — if `BEGIN` goes to another connection, the transaction does not hold.
 *    So `transaction` must always be provided (this is why the port requires it).
 */
import { HYPERTABLE_SQL, PostgresStore, type SqlClient } from '@aas/store';
import { fill, tr } from '@aas/core';
import { setupTimescaleFeatures, type TimescaleFeatures } from './timescale.js';

export interface PostgresOptions {
  connectionString: string;
  /** When using a separate schema. Important: leaving out `public` hides TimescaleDB's create_hypertable */
  schema?: string;
  /**
   * Whether to make the collected-values table a TimescaleDB hypertable. The default is **try it, and move on if it fails**.
   * Because it must also work on plain PostgreSQL (better not to be picky about the install target).
   */
  timescale?: boolean;
  /** Compression and aggregates on top of the hypertable (timescale.ts). Absent = none */
  features?: { settings: TimescaleFeatures; retentionDays: number };
  /** Connections the server keeps open at most (`PG_POOL_MAX`). Default {@link DEFAULT_POOL_MAX} */
  poolMax?: number;
}

/** pg's own default — what every server before 2.8.1 used */
export const DEFAULT_POOL_MAX = 10;

/**
 * `PG_POOL_MAX` — how many connections to PostgreSQL the server opens at most (2.8.1). A whole number from 1 to 1,000;
 * anything else is the default, so a typo does not stop the server.
 * Important: more is not simply faster. Since 2.8.1 a batch is one statement; in the load test of 2026-10-19, 600
 *    collectors sending 60,000 values a second were taken with p95 85 ms on 10 connections and 1.07 s on 20. Raise it
 *    for many people working at once, and keep the sum over every server below the database's `max_connections`.
 */
export function poolMaxFromEnv(env: NodeJS.ProcessEnv): number {
  const text = env['PG_POOL_MAX']?.trim() ?? '';
  const value = Number(text);
  return text !== '' && Number.isInteger(value) && value >= 1 && value <= 1_000 ? value : DEFAULT_POOL_MAX;
}

/**
 * Use it if present, skip it if not.
 * Important: installing the extension requires superuser — for deployments on a shared DB, an admin can enable it in advance.
 */
async function tryTimescale(client: SqlClient, features: PostgresOptions['features']): Promise<string> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  } catch {
    return tr('일반 PostgreSQL (timescaledb 확장 없음)');
  }
  try {
    await client.query(HYPERTABLE_SQL);
  } catch (error) {
    // e.g. when trying to convert a table that already holds data. Does not affect operation
    return fill(tr('일반 표로 둔다 ({0})'), { 0: error instanceof Error ? error.message : String(error) });
  }
  // Named as the Timescale License asks (2.4): the edition, never "TimescaleDB" alone
  const { rows } = await client.query<{ license: string | null }>("SELECT current_setting('timescaledb.license', true) AS license");
  const edition = rows[0]?.license === 'timescale' ? 'TimescaleDB Community Edition' : 'TimescaleDB Apache-2 Edition';
  const hypertable = fill(tr('{0} 하이퍼테이블'), { 0: edition });
  if (!features) return hypertable;
  try {
    return `${hypertable} · ${await setupTimescaleFeatures(client, features.settings, features.retentionDays)}`;
  } catch (error) {
    // Values are still stored without them — a failed setup must not stop the server
    return `${hypertable} · ${fill(tr('압축 · 집계 설정 실패 ({0})'), { 0: error instanceof Error ? error.message : String(error) })}`;
  }
}

export async function connectPostgres(
  options: PostgresOptions,
): Promise<{ store: PostgresStore; timescale: string }> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.poolMax ?? DEFAULT_POOL_MAX });

  if (options.schema) {
    const path = `"${options.schema}", public`;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${options.schema}"`);
    // Make every connection in the pool see the same schema
    pool.on('connect', (client) => void client.query(`SET search_path TO ${path}`));
    await pool.query(`SET search_path TO ${path}`);
  }

  const client: SqlClient = {
    query: async (text, params) => {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
    transaction: async (work) => {
      const connection = await pool.connect();
      // A connection whose ROLLBACK failed is broken — it is closed, not handed to the next caller mid-transaction
      let broken: Error | undefined;
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
        // Important: the error of the work is the one to report — a failed ROLLBACK must not replace it
        await connection.query('ROLLBACK').catch((rollback: unknown) => {
          broken = rollback instanceof Error ? rollback : new Error(String(rollback));
        });
        throw error;
      } finally {
        connection.release(broken);
      }
    },
  };

  const store = new PostgresStore(client);
  // Important: if the schema version is newer than the program, it stops here with SchemaVersionError — printed as-is in the startup log
  await store.init();
  const timescale = options.timescale === false ? tr('끔') : await tryTimescale(client, options.features);
  return { store, timescale: fill(tr('{0} · 스키마 {1}판'), { 0: timescale, 1: store.schemaVersion }) };
}
