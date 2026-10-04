/**
 * PostgreSQL 구현 검증.
 *
 * 이 PC에는 Docker도 Postgres도 없다. 그래서 **PGlite**(WASM으로 도는 진짜 PostgreSQL)로 돌린다 —
 * 모의 객체가 아니라 실제 엔진이므로 DDL·SQL 문법과 트랜잭션 의미가 그대로 검증된다.
 * 운영에서는 같은 SqlClient 자리에 `pg`의 Client/Pool을 꽂으면 된다(코드 변경 없음).
 */
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

// 🔴 PGlite는 테스트마다 WASM PostgreSQL을 새로 띄운다. 전체 테스트를 병렬로 돌리면 이 기동이
//    기본 5초를 넘겨 「무손실 왕복」이 시간 초과로 떨어졌다(단독으로는 통과 — 2026-09-30에 세 번 관찰).
//    로직이 아니라 기동 시간 문제라 이 파일에서만 넉넉히 준다
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

/** PGlite 인스턴스를 하나씩 새로 띄운다 — 테스트끼리 상태가 섞이면 안 된다 */
async function freshStore(): Promise<PostgresStore> {
  return new PostgresStore(clientOf(new PGlite()));
}

describeStore('PostgresStore (PGlite)', freshStore);
describeStoreFilters('PostgresStore (PGlite)', freshStore);

describe('스키마 판 번호 (schema_version)', () => {
  it('빈 DB — 최신 판으로 만들고 번호를 적는다. 다시 떠도 같은 번호', async () => {
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

  it('판 번호 도입 전의 DB — 표가 이미 있으면 1판으로 보고 자료를 지키며 번호만 적는다', async () => {
    const db = new PGlite();
    for (const statement of SCHEMA_SQL.split(';')) if (statement.trim()) await db.query(statement);
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await store.getPackage('p1'))?.name).toBe('old.aasx');
  });

  /**
   * 1판 표를 **되돌려 만든다** — 그 뒤 판에서 더한 것을 전부 뺀다.
   *
   * 🔴 빼는 것을 빠뜨리면 이 테스트가 조용히 쓸모없어진다. 「옛 DB」가 실은 최신 표라서
   *    마이그레이션을 한 줄도 타지 않고 통과해 버린다 — 2026-10-02에 3판(app_user)이
   *    실제로 그랬다. 판을 올릴 때는 **여기서도 빼야** 한다.
   */
  const V1_SCHEMA = SCHEMA_SQL
    // 2판 — 번들 첨부 역할
    .replace(
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra', 'bundle'))",
      "CHECK (role IN ('thumbnail', 'supplementary', 'extra'))",
    )
    // 3판 — 사용자 표
    .replace(/CREATE TABLE IF NOT EXISTS app_user \([^;]*\);/, '')
    // 6판 — 작업 공간(패키지의 주인)
    .replace(/^ *-- *주인\(작업 공간 열쇠\).*$/m, '')
    .replace(/^ *owner +text$/m, '')
    .replace(/^CREATE INDEX IF NOT EXISTS aas_package_owner_idx.*$/m, '')
    // 5판 — 회원가입 연락처
    .replace(/^ *-- *연락처\(선택\).*$/m, '')
    .replace(/^ *-- *UNIQUE도 걸지 않는다.*$/m, '')
    .replace(/^ *email +text$/m, '')
    // 4판 — 감사 기록의 「누가」. 주석까지 함께 지운다
    .replace(/^ *--.*app_user.*$/m, '')
    .replace(/^ *--.*그때의 것을 베껴.*$/m, '')
    .replace(/^ *actor_id +text,$/m, '')
    .replace(/^ *actor_name +text$/m, '')
    // 위에서 빈 줄과 꼬리 쉼표가 남는다 — `changed_at ...,` 다음을 원래대로 되돌린다
    .replace(/,\s*\)\s*;/g, '\n);');

  const bundleFile = {
    part: '/bundle/01_UseCase문서/a.docx',
    role: 'bundle' as const,
    contentType: 'application/octet-stream',
    data: new Uint8Array([1]),
  };

  it('1판 DB — 최신 판으로 올라가고 자료는 그대로다', async () => {
    expect(V1_SCHEMA).not.toBe(SCHEMA_SQL);
    const db = new PGlite();
    for (const statement of V1_SCHEMA.split(';')) if (statement.trim()) await db.query(statement);
    await db.query(SCHEMA_VERSION_TABLE);
    await db.query('INSERT INTO schema_version (version) VALUES (1)');
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    // 🔴 판 번호를 박아 두지 않는다 — 판이 오를 때마다 이 테스트가 깨지면
    //    "올랐다"는 사실만 알려 주고 정작 **올라갔는지**는 검사하지 못한다
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    await store.putPackageFile('p1', bundleFile);     // 2판 — 번들 첨부
    expect((await store.packageFiles('p1')).map((f) => f.role)).toEqual(['bundle']);
    // 3판 — 사용자 표. 옛 DB에도 생겨야 로그인이 선다
    expect(await store.countUsers()).toBe(0);
    const made = await store.createUser({
      login: 'admin', displayName: '관리자', role: 'admin', passwordHash: 'h',
    });
    expect((await store.findUserByLogin('admin'))?.id).toBe(made.id);
    // 4판 — 이력의 「누가」. 열이 없으면 INSERT가 통째로 터진다
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
    // 6판 — 작업 공간. 🔴 옛 패키지는 **공용으로 남는다** — 올린 뒤에도 모두가 본다
    expect((await store.getPackage('p1'))?.owner).toBeUndefined();
    const seen = await store.listPackages({}, { owner: 'user:아무나' });
    expect(seen.items.map((item) => item.id)).toContain('p1');
    // 색인은 표 정의가 아니라 마이그레이션에 있다 — 옮기면서 빠뜨리지 않았는지 본다
    const index = await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'aas_package_owner_idx'");
    expect(index.rows).toHaveLength(1);
  });

  it('🔴 판 번호 도입 전의 1판 표도 제약까지 올라간다 — IF NOT EXISTS만으로는 안 고쳐진다', async () => {
    const db = new PGlite();
    for (const statement of V1_SCHEMA.split(';')) if (statement.trim()) await db.query(statement);
    await db.query("INSERT INTO aas_package (id, name) VALUES ('p1', 'old.aasx')");

    const store = new PostgresStore(clientOf(db));
    await store.init();
    await store.putPackageFile('p1', bundleFile);
    expect((await store.packageFiles('p1')).map((f) => f.role)).toEqual(['bundle']);
  });

  it('DB가 프로그램보다 새로우면 기동을 거부한다 — 조용히 잃는 것보다 낫다', async () => {
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
