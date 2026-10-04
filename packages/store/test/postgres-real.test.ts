/**
 * 진짜 PostgreSQL 대조 — 운영 경로 검증.
 *
 * PGlite(WASM)는 같은 PostgreSQL 엔진이지만 **드라이버가 다르다.**
 * 운영에서는 `pg`가 붙고, 거기서 갈리는 것들이 있다 —
 * 타입 변환(bigint·timestamptz·jsonb), 연결 풀에서의 트랜잭션, bytea 인코딩.
 * 그래서 같은 적합성 시험을 **진짜 서버 + pg 드라이버**로 한 번 더 돌린다.
 *
 * 서버가 없으면 통째로 건너뛴다 — 장비가 없다고 다른 시험까지 막을 이유는 없다.
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
 * pg.Pool은 질의마다 연결이 달라진다 — BEGIN이 다른 연결로 가면 트랜잭션이 성립하지 않는다.
 * 그래서 `transaction`을 반드시 준다(포트가 이걸 요구하는 이유).
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

/** 시험마다 스키마를 새로 만든다 — 앞 시험이 남긴 것에 기대지 않는다 */
let counter = 0;
async function freshStore(): Promise<PostgresStore> {
  const pool = new pg.Pool({ connectionString: url });
  const schema = `aas_test_${Date.now()}_${counter++}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`SET search_path TO "${schema}"`);
  // 풀의 모든 연결이 같은 스키마를 보게 한다
  pool.on('connect', (client) => void client.query(`SET search_path TO "${schema}"`));
  const store = new PostgresStore(poolClient(pool));
  await store.init();
  return store;
}

if (!url) {
  describe.skip('진짜 PostgreSQL (DATABASE_URL 없음 — 건너뜀)', () => {
    it('건너뜀', () => undefined);
  });
} else {
  describeStore('PostgresStore (진짜 pg)', freshStore);
  describeStoreFilters('PostgresStore (진짜 pg)', freshStore);

  describe('운영 환경에서만 드러나는 것', () => {
    it('pg 드라이버의 타입 변환을 견딘다 — bigint·timestamptz·jsonb', async () => {
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
      // bigserial은 pg가 문자열로 준다 — 우리 레코드에서는 문자열 uid여야 한다
      expect(typeof submodel.uid).toBe('string');
      // timestamptz는 Date로 오는데 우리는 ISO 문자열로 돌려준다
      expect(submodel.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      // jsonb는 객체로 돌아온다
      expect(submodel.content['idShort']).toBe('Test');
    });

    it('TimescaleDB가 있으면 수집값 테이블을 하이퍼테이블로 바꿀 수 있다', async () => {
      const store = await freshStore();
      const pool = new pg.Pool({ connectionString: url });
      try {
        const extension = await pool.query(
          "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
        );
        if (extension.rowCount === 0) return; // 일반 PostgreSQL이면 건너뛴다

        // 스키마 이름을 알 수 없으므로 새 연결에서 직접 만든 뒤 시험한다
        const schema = `ts_test_${Date.now()}`;
        await pool.query(`CREATE SCHEMA "${schema}"`);
        const { SCHEMA_SQL, HYPERTABLE_SQL } = await import('@aas/store');
        for (const statement of SCHEMA_SQL.split(';')) {
          const sql = statement.trim();
          // 🔴 public을 search_path에서 빼면 TimescaleDB 함수(create_hypertable)가 안 보인다.
          // 우리 스키마를 쓰는 배포에서 똑같이 걸릴 함정이라 여기서도 같은 모양으로 둔다
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
