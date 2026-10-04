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
    expect((await api(join({ email: 'hong@example.com' }))).status).toBe(201);
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
