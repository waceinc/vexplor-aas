/**
 * 운영용 PostgreSQL 연결.
 *
 * `@aas/store`는 드라이버를 의존하지 않고 `SqlClient` 포트만 받는다(라이선스 검토를 늘리지 않기 위해서다).
 * 그 포트를 `pg`(MIT)로 채우는 자리가 여기다. **동적 import**를 쓰는 이유는
 * `DATABASE_URL` 없이 띄우는 배포(시연·개발)에서 드라이버를 아예 읽지 않게 하기 위해서다.
 *
 * 🔴 `pg.Pool`은 질의마다 연결이 달라진다 — `BEGIN`이 다른 연결로 가면 트랜잭션이 성립하지 않는다.
 *    그래서 `transaction`을 반드시 준다(포트가 이것을 요구하는 이유다).
 */
import { HYPERTABLE_SQL, PostgresStore, type SqlClient } from '@aas/store';

export interface PostgresOptions {
  connectionString: string;
  /** 스키마를 나눠 쓸 때. 🔴 `public`을 빼면 TimescaleDB의 create_hypertable이 안 보인다 */
  schema?: string;
  /**
   * 수집값 표를 TimescaleDB 하이퍼테이블로 둘지. 기본은 **해 보고, 안 되면 그냥 간다**.
   * 일반 PostgreSQL에서도 동작해야 하기 때문이다(설치처를 가리지 않는 편이 낫다).
   */
  timescale?: boolean;
}

/**
 * 있으면 쓰고 없으면 넘어간다.
 * 🔴 확장 설치에는 superuser가 필요하다 — 공용 DB에 얹는 배포라면 관리자가 미리 켜 두면 된다.
 */
async function tryTimescale(client: SqlClient): Promise<string> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  } catch {
    return '일반 PostgreSQL (timescaledb 확장 없음)';
  }
  try {
    await client.query(HYPERTABLE_SQL);
    return 'TimescaleDB 하이퍼테이블';
  } catch (error) {
    // 이미 자료가 든 표를 뒤늦게 바꾸려 할 때 등. 동작에는 지장이 없다
    return `일반 표로 둔다 (${error instanceof Error ? error.message : String(error)})`;
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
    // 풀의 모든 연결이 같은 스키마를 보게 한다
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
  // 🔴 스키마 판이 프로그램보다 새로우면 여기서 SchemaVersionError로 멈춘다 — 기동 로그에 그대로 찍힌다
  await store.init();
  const timescale = options.timescale === false ? '끔' : await tryTimescale(client);
  return { store, timescale: `${timescale} · 스키마 ${store.schemaVersion}판` };
}
