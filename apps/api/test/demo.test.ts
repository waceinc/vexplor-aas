/**
 * 체험판 · 회원가입.
 *
 * 🔴 여기서 지키는 둘.
 *   ① 체험 계정은 **파일을 가지고 나가지 못한다.** 가입한 계정은 나간다 — 그것이 가입할 이유다
 *   ② 가입은 **기본으로 닫혀 있다.** 사내망 서버에서 아무나 계정을 만들면 안 된다
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { demoFromEnv, isFileDownload, seedDemoUser } from '../src/demo.js';
import { hashPassword } from '../src/password.js';
import type { ApiRequest } from '../src/http.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-롤포밍기-공34.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const submodelId = readAasx(goldenBytes).environment.submodels![0]!.id;
const encoded = Buffer.from(submodelId, 'utf8').toString('base64url');

type Reply = { status: number; headers: Record<string, string>; body: any };
type Api = (request: ApiRequest) => Promise<Reply>;

function ask(
  method: string,
  path: string,
  init: { body?: unknown; cookie?: string; query?: Record<string, string> } = {},
): ApiRequest {
  return {
    method,
    path,
    query: init.query ?? {},
    headers: init.cookie ? { cookie: init.cookie } : {},
    ...(init.body === undefined ? {} : { body: init.body }),
  } as ApiRequest;
}

const cookieFrom = (reply: Reply): string => (reply.headers?.['set-cookie'] ?? '').split(';')[0] ?? '';

const DEMO = { login: 'admin', password: '1234', displayName: '체험 계정', role: 'editor' as const, resetMinutes: 60 };

async function demoServer(): Promise<{ api: Api; demoCookie: string; packageId: string }> {
  const store = new InMemoryStore();
  await store.init();
  await seedDemoUser(store, DEMO, hashPassword);
  const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;

  const logged = await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' } }));
  expect(logged.status).toBe(200);
  const demoCookie = cookieFrom(logged);

  const made = await api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie: demoCookie }));
  expect(made.status).toBe(201);
  return { api, demoCookie, packageId: made.body.packageId };
}

describe('설정 읽기', () => {
  it('기본은 꺼져 있다 — 내려받아 직접 돌리는 사람에게는 제한이 없다', () => {
    expect(demoFromEnv({})).toBeUndefined();
    expect(demoFromEnv({ DEMO_MODE: 'off' })).toBeUndefined();
  });

  it('켜면 admin/1234 · 60분마다 정리가 기본이다', () => {
    expect(demoFromEnv({ DEMO_MODE: 'on' })).toMatchObject({
      login: 'admin',
      password: '1234',
      resetMinutes: 60,
    });
  });

  it('운영자가 바꿀 수 있다', () => {
    const demo = demoFromEnv({
      DEMO_MODE: 'on',
      AAS_DEMO_LOGIN: 'TryMe',
      AAS_DEMO_PASSWORD: '구경하세요',
      AAS_DEMO_RESET_MINUTES: '15',
    });
    // 로그인 이름은 소문자로 맞춘다 — 저장소가 그렇게 찾는다
    expect(demo).toMatchObject({ login: 'tryme', password: '구경하세요', resetMinutes: 15 });
  });

  it('🔴 막는 기준은 경로가 아니라 **나가는 응답**이다 — 경로가 늘어도 빠뜨릴 자리가 없다', () => {
    expect(isFileDownload({ status: 200, headers: { 'content-disposition': 'attachment; filename="a.aasx"' } })).toBe(true);
    // 검증 결과서는 화면으로 본다 — 도구가 무엇을 해 주는지는 보여 줘야 체험이 성립한다
    expect(isFileDownload({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })).toBe(false);
    expect(isFileDownload({ status: 200, headers: {} })).toBe(false);
  });
});

describe('체험 계정은 파일을 가지고 나가지 못한다', () => {
  it('🔴 AASX 내려받기가 막힌다', async () => {
    const { api, demoCookie, packageId } = await demoServer();
    const got = await api(ask('GET', `/packages/${packageId}`, { cookie: demoCookie }));
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toContain('회원가입');
  });

  it('고치고 보는 것은 다 된다 — 그래야 체험이 성립한다', async () => {
    const { api, demoCookie, packageId } = await demoServer();
    expect((await api(ask('GET', `/packages/${packageId}/lint`, { cookie: demoCookie }))).status).toBe(200);
    // 검증 결과서는 화면으로 열린다(첨부가 아니다)
    expect((await api(ask('GET', `/packages/${packageId}/report`, { cookie: demoCookie }))).status).toBe(200);
    const current = await api(ask('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, { cookie: demoCookie }));
    const saved = await api(
      ask('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
        body: { ...current.body, idShort: '고쳐본다' },
        cookie: demoCookie,
      }),
    );
    expect(saved.status).toBe(204);
  });

  it('🔴 가입한 계정은 **자기 것을** 내려받는다 — 가입할 이유가 바로 이것이다', async () => {
    const { api } = await demoServer();
    const joined = await api(
      ask('POST', '/auth/signup', {
        body: { login: 'hong', displayName: '홍길동', password: '열자가넘는비밀번호입니다' },
      }),
    );
    expect(joined.status).toBe(201);
    const cookie = cookieFrom(joined);
    const mine = await api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie }));
    const got = await api(ask('GET', `/packages/${mine.body.packageId}`, { cookie }));
    expect(got.status).toBe(200);
    expect(got.body).toBeInstanceOf(Uint8Array);
  });

  it('남이 올린 것은 가입해도 못 받는다 — 보이지도 않는다(작업 공간이 따로다)', async () => {
    const { api, packageId } = await demoServer(); // 체험 방문자가 올린 것
    const joined = await api(ask('POST', '/auth/signup', {
      body: { login: 'hong', password: '열자가넘는비밀번호입니다' },
    }));
    expect((await api(ask('GET', `/packages/${packageId}`, { cookie: cookieFrom(joined) }))).status).toBe(404);
  });

  it('로그인하지 않은 사람은 아무것도 못 한다 — 체험 계정의 내려받기 막기를 돌아가는 길이 없다', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    // 서버가 올린 템플릿 — 주인이 없어 누구에게나 보인다
    const template = await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    // 🔴 예전에는 로그인 없이 부르면 「키 없는 서버」로 보고 열어 주었다(2026-10-06 출시 전 검토).
    //    계정이 있는 서버에서는 로그인부터다
    expect((await api(ask('GET', `/packages/${template.id}/lint`))).status).toBe(401);
    expect((await api(ask('GET', `/packages/${template.id}`))).status).toBe(401);
    expect((await api(ask('POST', '/packages/new', { body: { assetName: 'Sneaky' } }))).status).toBe(401);
  });

  it('화면이 무엇을 보일지 알 수 있다 — 체험 계정일 때만 체험이라고 말한다', async () => {
    const { api, demoCookie } = await demoServer();
    const asDemo = await api(ask('GET', '/auth/me', { cookie: demoCookie }));
    expect(asDemo.body).toMatchObject({ demo: { login: 'admin', password: '1234' }, signupAllowed: true });

    const joined = await api(
      ask('POST', '/auth/signup', {
        body: { login: 'hong', password: '열자가넘는비밀번호입니다' },
      }),
    );
    const asMember = await api(ask('GET', '/auth/me', { cookie: cookieFrom(joined) }));
    expect(asMember.body.demo).toBeUndefined();
  });
});

describe('회원가입', () => {
  async function server(signup?: { role: 'admin' | 'editor' | 'viewer' }): Promise<Api> {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'owner', displayName: '주인', role: 'admin', passwordHash: await hashPassword('열자가넘는비밀번호입니다'),
    });
    return createApi(store, signup ? { signup } : {}) as Api;
  }

  const join = (extra: Record<string, unknown> = {}): ApiRequest =>
    ask('POST', '/auth/signup', { body: { login: 'hong', password: '열자가넘는비밀번호입니다', ...extra } });

  it('🔴 기본은 닫혀 있다 — 사내망 서버에서 아무나 계정을 만들면 안 된다', async () => {
    const api = await server();
    const denied = await api(join());
    expect(denied.status).toBe(403);
    expect((await api(ask('GET', '/auth/me'))).body.signupAllowed).toBeUndefined();
  });

  it('열면 가입되고 바로 로그인된다', async () => {
    const api = await server({ role: 'editor' });
    const joined = await api(join({ displayName: '홍길동' }));
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ login: 'hong', displayName: '홍길동', role: 'editor' });
    const me = await api(ask('GET', '/auth/me', { cookie: cookieFrom(joined) }));
    expect(me.body).toMatchObject({ authenticated: true, user: { login: 'hong' } });
  });

  it('🔴 가입한다고 관리자가 되지 않는다 — 역할은 운영자가 정한다', async () => {
    const api = await server({ role: 'viewer' });
    const joined = await api(join());
    expect(joined.body.user.role).toBe('viewer');
    // 역할을 본문으로 밀어 넣어도 무시한다
    const sneaky = await api(ask('POST', '/auth/signup', {
      body: { login: 'kim', password: '열자가넘는비밀번호입니다', role: 'admin' },
    }));
    expect(sneaky.body.user.role).toBe('viewer');
  });

  it('비밀번호 규칙은 그대로 받는다 — 체험 계정의 1234는 서버가 직접 심은 예외다', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(join({ password: '1234' }))).status).toBe(400);
  });

  it('이미 쓰는 이름이면 그렇다고 알려 준다 — 숨기면 가입을 못 한다', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(ask('POST', '/auth/signup', {
      body: { login: 'owner', password: '열자가넘는비밀번호입니다' },
    }))).status).toBe(409);
  });

  it('연락처는 선택이다 — 비워도 가입된다', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(join({ email: '' }))).status).toBe(201);
  });

  it('적으면 모양만 본다 — 확인 메일은 보내지 않는다(처리방침을 올려 둔 서버)', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, {
      signup: { role: 'editor', privacyUrl: 'https://example.com/privacy' },
    }) as Api;
    expect((await api(ask('POST', '/auth/signup', {
      body: { login: 'kim', password: '열자가넘는비밀번호입니다', displayName: '김', company: 'X', agreed: true, email: '골뱅이없음' },
    }))).status).toBe(400);
    const ok = await api(ask('POST', '/auth/signup', {
      body: { login: 'lee', password: '열자가넘는비밀번호입니다', displayName: '이', company: 'X', agreed: true, email: 'lee@example.com' },
    }));
    expect(ok.status).toBe(201);
    // 🔴 응답에 연락처를 싣지 않는다 — 화면이 쓸 일이 없다
    expect(JSON.stringify(ok.body)).not.toContain('lee@example.com');
  });
});
