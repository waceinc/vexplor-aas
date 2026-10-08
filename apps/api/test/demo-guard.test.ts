/**
 * 체험 서버를 공개한 뒤 **실제로 깨질 수 있는 자리**들.
 *
 * 전문가 점검(2026-10-04)에서 찾은 것 다섯. 기능이 아니라 **운영이 깨지는 길**이다.
 *   ① 체험 계정이 자기 비밀번호를 바꿔 공개 서버를 죽이는 것
 *   ② 탈퇴가 없어 「지워 달라」는 요구에 응하지 못하는 것
 *   ③ 지운 계정 때문에 감사 기록이 함께 사라지는 것
 *   ④ 처리방침 없이 연락처를 모으는 것
 *   ⑤ 봇이 계정을 무한히 만드는 것
 */
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { seedDemoUser } from '../src/demo.js';
import { hashPassword } from '../src/password.js';
import { SignupThrottle } from '../src/session.js';
import type { ApiRequest } from '../src/http.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-롤포밍기-공34.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));

type Reply = { status: number; headers: Record<string, string>; body: any };
type Api = (request: ApiRequest) => Promise<Reply>;

const PASSWORD = '열자가넘는비밀번호입니다';
const DEMO = { login: 'admin', password: '1234', displayName: '체험 계정', role: 'editor' as const, resetMinutes: 60 };

function ask(
  method: string,
  path: string,
  init: { body?: unknown; cookie?: string; query?: Record<string, string>; from?: string } = {},
): ApiRequest {
  const headers: Record<string, string> = {};
  if (init.cookie) headers['cookie'] = init.cookie;
  if (init.from) headers['x-forwarded-for'] = init.from;
  return {
    method,
    path,
    query: init.query ?? {},
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  } as ApiRequest;
}

const cookieFrom = (reply: Reply): string => (reply.headers?.['set-cookie'] ?? '').split(';')[0] ?? '';

async function demoServer(): Promise<{ api: Api; demoCookie: string }> {
  const store = new InMemoryStore();
  await store.init();
  await seedDemoUser(store, DEMO, hashPassword);
  const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
  const logged = await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' } }));
  expect(logged.status).toBe(200);
  return { api, demoCookie: cookieFrom(logged) };
}

describe('🔴 체험 계정은 자기 자신을 못 바꾼다', () => {
  it('비밀번호를 바꾸지 못한다 — 바꾸면 공개 체험 서버가 죽는다', async () => {
    const { api, demoCookie } = await demoServer();
    const tried = await api(
      ask('POST', '/auth/password', {
        body: { current: '1234', next: '내가정한열자이상비밀번호' },
        cookie: demoCookie,
      }),
    );
    expect(tried.status).toBe(403);
    // 막은 뒤에도 원래 비밀번호로 들어가진다 — 다음 방문자가 쓸 수 있어야 한다
    expect((await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' } }))).status).toBe(200);
  });

  it('탈퇴하지 못한다 — 지우면 다음 사람이 못 들어온다', async () => {
    const { api, demoCookie } = await demoServer();
    expect((await api(ask('DELETE', '/auth/me', { cookie: demoCookie }))).status).toBe(403);
  });

  it('가입한 사람은 둘 다 된다 — 막는 것은 공용 계정뿐이다', async () => {
    const { api } = await demoServer();
    const joined = await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } }));
    const cookie = cookieFrom(joined);
    const changed = await api(
      ask('POST', '/auth/password', { body: { current: PASSWORD, next: '새로정한열자이상비밀번호' }, cookie }),
    );
    expect(changed.status).toBe(200);
  });
});

describe('탈퇴', () => {
  async function withOwner(): Promise<{ api: Api; store: InMemoryStore }> {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'owner',
      displayName: '주인',
      role: 'admin',
      passwordHash: await hashPassword(PASSWORD),
    });
    return { api: createApi(store, { signup: { role: 'editor' } }) as Api, store };
  }

  it('지우면 그 계정으로 못 들어온다 — 잠그기가 아니라 삭제다', async () => {
    const { api } = await withOwner();
    const joined = await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } }));
    expect((await api(ask('DELETE', '/auth/me', { cookie: cookieFrom(joined) }))).status).toBe(204);
    expect((await api(ask('POST', '/auth/login', { body: { login: 'hong', password: PASSWORD } }))).status).toBe(401);
  });

  it('🔴 지워도 「누가 바꿨나」는 남는다 — 감사 기록이 소급해 사라지면 안 된다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { signup: { role: 'editor' } }) as Api;
    const joined = await api(
      ask('POST', '/auth/signup', { body: { login: 'hong', displayName: '홍길동', password: PASSWORD } }),
    );
    const cookie = cookieFrom(joined);

    const made = await api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie }));
    const packageId = made.body.packageId as string;
    const submodels = await store.listIdentifiables(packageId, 'Submodel');
    const target = submodels.items[0]!;
    const encoded = Buffer.from(target.id, 'utf8').toString('base64url');
    const current = await api(ask('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, { cookie }));
    await api(
      ask('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
        body: { ...current.body, idShort: '고침' },
        cookie,
      }),
    );

    expect((await api(ask('DELETE', '/auth/me', { cookie }))).status).toBe(204);

    const history = await api(ask('GET', `/packages/${packageId}/history/${encoded}`));
    expect(history.body.result[0].actorName).toBe('홍길동');
  });

  it('🔴 탈퇴하면 그 사람이 올린 파일도 지운다 — 남의 파일은 그대로 (2026-10-06)', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { signup: { role: 'editor' }, privateWorkspaces: true }) as Api;
    const hong = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    const kim = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'kim', password: PASSWORD } })));
    const upload = (cookie: string) => api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie }));
    expect((await upload(hong)).status).toBe(201);
    expect((await upload(hong)).status).toBe(201);
    const kept = (await upload(kim)).body.packageId as string;

    expect((await api(ask('DELETE', '/auth/me', { cookie: hong }))).status).toBe(204);

    const left = (await store.listPackages()).items.map((item) => item.id);
    expect(left).toEqual([kept]);
  });

  it('마지막 관리자는 못 지운다 — 지우면 아무도 계정을 관리하지 못한다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as Api;
    const made = await api(ask('POST', '/auth/setup', { body: { login: 'owner', password: PASSWORD } }));
    expect((await api(ask('DELETE', '/auth/me', { cookie: cookieFrom(made) }))).status).toBe(409);
  });
});

describe('🔴 처리방침이 없으면 연락처를 받지 않는다', () => {
  async function server(privacyUrl?: string): Promise<Api> {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'owner',
      displayName: '주인',
      role: 'admin',
      passwordHash: await hashPassword(PASSWORD),
    });
    return createApi(store, {
      signup: { role: 'editor', ...(privacyUrl ? { privacyUrl } : {}) },
    }) as Api;
  }

  const join = (extra: Record<string, unknown> = {}): ApiRequest =>
    ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD, ...extra } });

  it('방침 없이 연락처를 보내면 거절한다 — 어떻게 쓰는지 못 밝히면 받지 않는다', async () => {
    const api = await server();
    expect((await api(join({ email: 'hong@example.com' }))).status).toBe(400);
    // 비우면 가입은 된다 — 연락처 없이도 쓸 수 있어야 한다
    expect((await api(join())).status).toBe(201);
  });

  it('방침을 올려 두면 받는다. 화면도 그 주소를 받아 간다', async () => {
    const api = await server('https://example.com/privacy');
    // 방침을 올린 서버는 이름 · 회사명 · 이메일과 동의를 함께 받는다(2026-10-06)
    expect((await api(join({ email: 'hong@example.com' }))).status).toBe(400);
    expect(
      (await api(join({ email: 'hong@example.com', displayName: '홍길동', company: 'WACE', agreed: true }))).status,
    ).toBe(201);
    expect((await api(ask('GET', '/auth/me'))).body.privacyUrl).toBe('https://example.com/privacy');
  });
});

describe('가입 속도 제한', () => {
  async function withThrottle(globalLimit: number, addressLimit: number): Promise<Api> {
    const store = new InMemoryStore();
    await store.init();
    return createApi(store, {
      signup: { role: 'editor' },
      signupThrottle: new SignupThrottle(() => Date.now(), globalLimit, addressLimit),
    }) as Api;
  }

  const join = (n: number, from: string): ApiRequest =>
    ask('POST', '/auth/signup', { body: { login: `user${n}`, password: PASSWORD }, from });

  it('같은 곳에서 너무 많이 만들면 막는다', async () => {
    const api = await withThrottle(100, 3);
    for (let n = 0; n < 3; n += 1) expect((await api(join(n, '203.0.113.9'))).status).toBe(201);
    expect((await api(join(9, '203.0.113.9'))).status).toBe(429);
  });

  it('🔴 전체 상한도 있다 — 주소는 속일 수 있어 그것만으로는 못 막는다', async () => {
    const api = await withThrottle(2, 100);
    expect((await api(join(1, '198.51.100.1'))).status).toBe(201);
    expect((await api(join(2, '198.51.100.2'))).status).toBe(201);
    // 주소를 매번 바꿔도 전체 상한에는 걸린다
    expect((await api(join(3, '198.51.100.3'))).status).toBe(429);
  });

  it('실패한 시도는 세지 않는다 — 계정을 만들지 않았으니 셀 이유가 없다', async () => {
    const api = await withThrottle(100, 2);
    const bad = ask('POST', '/auth/signup', { body: { login: 'hong', password: '짧다' }, from: '203.0.113.1' });
    for (let n = 0; n < 5; n += 1) expect((await api(bad)).status).toBe(400);
    expect(
      (await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD }, from: '203.0.113.1' })))
        .status,
    ).toBe(201);
  });
});

describe('공개 서버를 남이 망가뜨리지 못한다 (2026-10-06 보안 점검)', () => {
  it('🔴 틀린 비밀번호를 아무리 넣어도 체험 계정은 잠기지 않는다 — 모든 방문자가 막히던 구멍', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    for (let i = 0; i < 8; i += 1) {
      await api(ask('POST', '/auth/login', { body: { login: 'admin', password: 'wrong' }, from: '203.0.113.9' }));
    }
    // 같은 회사 망(같은 주소) 뒤의 방문자도 막히면 안 된다 — 체험 계정은 아예 세지 않는다
    const visitor = await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' }, from: '203.0.113.9' }));
    expect(visitor.status).toBe(200);
    // scrypt를 열 번 가까이 돈다(일부러 느린 해시) — 시험을 한꺼번에 돌리면 5초를 넘긴다
  }, 30_000);

  it('한 사람이 올릴 수 있는 파일 수에 상한이 있다 — 디스크를 채우지 못한다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { signup: { role: 'editor' }, privateWorkspaces: true, maxPackagesPerOwner: 2 }) as Api;
    const cookie = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    const upload = () => api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie }));
    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(201);
    const third = await upload();
    expect(third.status).toBe(403);
    expect(JSON.stringify(third.body)).toContain('2개까지');
  });
});

describe('회원가입 — 이름 · 회사명 · 이메일 · 동의 (처리방침을 올린 서버, 2026-10-06)', () => {
  async function server(): Promise<{ api: Api; store: InMemoryStore; adminCookie: string }> {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { signup: { role: 'editor', privacyUrl: '/privacy.html' } }) as Api;
    const adminCookie = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    return { api, store, adminCookie };
  }
  const full = { login: 'kim', password: PASSWORD, displayName: '김철수', company: 'WACE', email: 'kim@example.com', agreed: true };

  it('이름 · 이메일 중 하나라도 비면 받지 않는다', async () => {
    const { api } = await server();
    for (const missing of ['displayName', 'email'] as const) {
      const reply = await api(ask('POST', '/auth/signup', { body: { ...full, [missing]: '' } }));
      expect(reply.status).toBe(400);
    }
  });

  it('회사명은 비워도 가입된다(2026-10-08 사용자 요청)', async () => {
    const { api, store } = await server();
    expect((await api(ask('POST', '/auth/signup', { body: { ...full, company: '' } }))).status).toBe(201);
    expect((await store.findUserByLogin('kim'))?.company).toBeUndefined();
  });

  it('🔴 동의하지 않으면 받지 않는다 — 화면의 체크만 믿지 않는다', async () => {
    const { api } = await server();
    expect((await api(ask('POST', '/auth/signup', { body: { ...full, agreed: false } }))).status).toBe(400);
  });

  it('받으면 동의 시각을 서버가 적고, 회사명·이메일은 관리자에게만 보인다', async () => {
    const { api, store, adminCookie } = await server();
    const joined = await api(ask('POST', '/auth/signup', { body: full }));
    expect(joined.status).toBe(201);
    const saved = await store.findUserByLogin('kim');
    expect(saved?.company).toBe('WACE');
    expect(saved?.consentAt).toBeDefined();

    const list = await api(ask('GET', '/auth/users', { cookie: adminCookie }));
    expect(list.body.result.find((user: { login: string }) => user.login === 'kim')).toMatchObject({
      company: 'WACE',
      email: 'kim@example.com',
    });
    // 가입한 본인(편집자)은 남의 목록을 못 본다
    expect((await api(ask('GET', '/auth/users', { cookie: cookieFrom(joined) }))).status).toBe(403);
  });

  it('처리방침이 없는 서버는 회사명·이메일을 받지 않는다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { signup: { role: 'editor' } }) as Api;
    expect((await api(ask('POST', '/auth/signup', { body: { login: 'lee', password: PASSWORD, company: 'X' } }))).status).toBe(400);
    expect((await api(ask('POST', '/auth/signup', { body: { login: 'lee', password: PASSWORD } }))).status).toBe(201);
  });
});

describe('내 계정 설정 — 내 정보 고치기 (2026-10-08 사용자 요청)', () => {
  async function server(): Promise<{ api: Api; store: InMemoryStore; boss: string; demo: string }> {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD), email: 'boss@example.com', company: 'WACE' });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    const boss = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    const demo = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: DEMO.login, password: DEMO.password } })));
    return { api, store, boss, demo };
  }

  it('표시 이름 · 회사명 · 이메일을 바꾸고, 내 화면에 그대로 보인다', async () => {
    const { api, store, boss } = await server();
    const reply = await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: 'WACE 관리자', company: '와이스', email: 'admin@example.com' } }));
    expect(reply.status).toBe(200);
    expect(reply.body.user).toMatchObject({ displayName: 'WACE 관리자', company: '와이스', email: 'admin@example.com', role: 'admin' });
    const me = await api(ask('GET', '/auth/me', { cookie: boss }));
    expect(me.body.user).toMatchObject({ displayName: 'WACE 관리자', company: '와이스' });
    // 빈 값은 지운다
    await api(ask('PATCH', '/auth/me', { cookie: boss, body: { company: '' } }));
    expect((await store.findUserByLogin('boss'))?.company).toBeUndefined();
  });

  it('🔴 역할 · 로그인 이름은 여기서 못 바꾼다 — 보내도 무시된다', async () => {
    const { api, store, boss } = await server();
    await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: '나', role: 'viewer', login: 'other' } }));
    const saved = await store.findUserByLogin('boss');
    expect(saved?.role).toBe('admin');
    expect(await store.findUserByLogin('other')).toBeUndefined();
  });

  it('잘못된 값 · 데모 계정 · 로그인 안 한 사람은 거절한다', async () => {
    const { api, boss, demo } = await server();
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: '' } }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: { email: '골뱅이없음' } }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: {} }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: demo, body: { displayName: '해커' } }))).status).toBe(403);
    expect((await api(ask('PATCH', '/auth/me', { body: { displayName: '누구' } }))).status).toBe(401);
  });
});

describe('관리자의 계정 삭제 (2026-10-06 사용자 요청)', () => {
  async function server(): Promise<{ api: Api; store: InMemoryStore; boss: string }> {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    const boss = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    return { api, store, boss };
  }

  it('지우면 그 사람과 그 사람이 올린 파일이 함께 사라진다', async () => {
    const { api, store, boss } = await server();
    const hong = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    expect((await api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie: hong }))).status).toBe(201);
    const id = (await store.findUserByLogin('hong'))!.id;

    const reply = await api(ask('DELETE', `/auth/users/${id}`, { cookie: boss }));
    expect(reply.status).toBe(200);
    expect(reply.body.files).toBe(1);
    expect(await store.findUserByLogin('hong')).toBeUndefined();
    expect((await store.listPackages()).items.filter((item) => item.owner === `user:${id}`)).toHaveLength(0);
    // 그 사람의 로그인도 바로 끊긴다
    expect((await api(ask('GET', '/auth/me', { cookie: hong }))).body.authenticated).toBe(false);
  });

  it('🔴 막는 것 — 나 자신 · 체험 계정 · 관리자가 아닌 사람', async () => {
    const { api, store, boss } = await server();
    const me = (await store.findUserByLogin('boss'))!.id;
    expect((await api(ask('DELETE', `/auth/users/${me}`, { cookie: boss }))).status).toBe(409);
    const demo = (await store.findUserByLogin('admin'))!.id;
    expect((await api(ask('DELETE', `/auth/users/${demo}`, { cookie: boss }))).status).toBe(403);
    const hong = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    expect((await api(ask('DELETE', `/auth/users/${me}`, { cookie: hong }))).status).toBe(403);
  });
});

describe('🔴 체험 계정은 관리자도 바꾸지 못한다 (2026-10-06 보안 점검)', () => {
  it('역할을 관리자로 올리면 admin/1234로 들어온 누구나 관리자가 된다 — 막는다', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    const boss = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    const demo = (await store.findUserByLogin('admin'))!;
    for (const body of [{ role: 'admin' }, { disabled: true }, { password: '새로운긴비밀번호입니다' }]) {
      expect((await api(ask('PATCH', `/auth/users/${demo.id}`, { body, cookie: boss }))).status).toBe(403);
    }
    expect((await store.findUserByLogin('admin'))?.role).toBe('editor');
    // 관리자 목록에는 체험 계정이라고 적혀 간다 — 화면이 단추를 뺀다
    const list = await api(ask('GET', '/auth/users', { cookie: boss }));
    expect(list.body.result.find((user: { login: string }) => user.login === 'admin').demo).toBe(true);
  });
});
