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

export interface PostgresOptions {
  connectionString: string;
  /** When using a separate schema. Important: leaving out `public` hides TimescaleDB's create_hypertable */
  schema?: string;
  /**
   * Whether to make the collected-values table a TimescaleDB hypertable. The default is **try it, and move on if it fails**.
   * Because it must also work on plain PostgreSQL (better not to be picky about the install target).
   */
  timescale?: boolean;
}

/**
 * Use it if present, skip it if not.
 * Important: installing the extension requires superuser — for deployments on a shared DB, an admin can enable it in advance.
 */
async function tryTimescale(client: SqlClient): Promise<string> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  } catch {
    return tr('일반 PostgreSQL (timescaledb 확장 없음)');
  }
  try {
    await client.query(HYPERTABLE_SQL);
    return tr('TimescaleDB 하이퍼테이블');
  } catch (error) {
    // e.g. when trying to convert a table that already holds data. Does not affect operation
    return fill(tr('일반 표로 둔다 ({0})'), { 0: error instanceof Error ? error.message : String(error) });
  }
}

export async function connectPostgres(
  options: PostgresOptions,
): Promise<{ store: PostgresStore; timescale: string }> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: options.connectionString });

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

  const store = new PostgresStore(client);
  // Important: if the schema version is newer than the program, it stops here with SchemaVersionError — printed as-is in the startup log
  await store.init();
  const timescale = options.timescale === false ? tr('끔') : await tryTimescale(client);
  return { store, timescale: fill(tr('{0} · 스키마 {1}판'), { 0: timescale, 1: store.schemaVersion }) };
}
