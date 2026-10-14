/**
 * Demo edition and sign-up.
 *
 * Important: two things guarded here.
 *   1. A demo account **cannot take files out.** A signed-up account can — that is the reason to sign up
 *   2. Sign-up is **closed by default.** On an intranet server, anyone must not be able to create accounts
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { demoFromEnv, isFileDownload, seedDemoUser } from '../src/demo.js';
import { hashPassword, verifyPassword } from '../src/password.js';
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

describe('reading configuration', () => {
  it('off by default — no restrictions for people who download and run it themselves', () => {
    expect(demoFromEnv({})).toBeUndefined();
    expect(demoFromEnv({ DEMO_MODE: 'off' })).toBeUndefined();
  });

  it('when on, defaults are demo/0629, a demo account, and cleanup every 60 minutes', () => {
    expect(demoFromEnv({ DEMO_MODE: 'on' })).toMatchObject({
      login: 'demo',
      password: '0629',
      displayName: '데모 계정',
      resetMinutes: 60,
    });
  });

  it('Important: an existing demo account is also aligned to the configured password and name — changed settings take effect on the production server', async () => {
    const store = new InMemoryStore();
    await seedDemoUser(store, { ...DEMO, password: '1234', displayName: '체험 계정' }, hashPassword, verifyPassword);
    expect(await seedDemoUser(store, { ...DEMO, password: '0629', displayName: '데모 계정' }, hashPassword, verifyPassword)).toBe('updated');
    const user = await store.findUserByLogin('admin');
    expect(user?.displayName).toBe('데모 계정');
    expect(await verifyPassword('0629', user!.passwordHash)).toBe(true);
    expect(await verifyPassword('1234', user!.passwordHash)).toBe(false);
    expect(await seedDemoUser(store, { ...DEMO, password: '0629', displayName: '데모 계정' }, hashPassword, verifyPassword)).toBe('exists');
  });

  it('the operator can change it', () => {
    const demo = demoFromEnv({
      DEMO_MODE: 'on',
      AAS_DEMO_LOGIN: 'TryMe',
      AAS_DEMO_PASSWORD: '구경하세요',
      AAS_DEMO_RESET_MINUTES: '15',
    });
    // Login names are lowercased — that is how the store looks them up
    expect(demo).toMatchObject({ login: 'tryme', password: '구경하세요', resetMinutes: 15 });
  });

  it('Important: the block is based on **the outgoing response**, not the path — new paths leave no gap', () => {
    expect(isFileDownload({ status: 200, headers: { 'content-disposition': 'attachment; filename="a.aasx"' } })).toBe(true);
    // The validation report is viewed on screen — the demo only works if it shows what the tool does
    expect(isFileDownload({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })).toBe(false);
    expect(isFileDownload({ status: 200, headers: {} })).toBe(false);
  });
});

describe('a demo account cannot take files out', () => {
  it('Important: AASX download is blocked', async () => {
    const { api, demoCookie, packageId } = await demoServer();
    const got = await api(ask('GET', `/packages/${packageId}`, { cookie: demoCookie }));
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toContain('회원가입');
  });

  it('editing and viewing all work — otherwise the demo does not work', async () => {
    const { api, demoCookie, packageId } = await demoServer();
    expect((await api(ask('GET', `/packages/${packageId}/lint`, { cookie: demoCookie }))).status).toBe(200);
    // The validation report opens on screen (not as an attachment)
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

  it('Important: a signed-up account downloads **its own** files — that is exactly the reason to sign up', async () => {
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

  it('cannot get files uploaded by others even after signing up — they are not even visible (separate workspaces)', async () => {
    const { api, packageId } = await demoServer(); // uploaded by a demo visitor
    const joined = await api(ask('POST', '/auth/signup', {
      body: { login: 'hong', password: '열자가넘는비밀번호입니다' },
    }));
    expect((await api(ask('GET', `/packages/${packageId}`, { cookie: cookieFrom(joined) }))).status).toBe(404);
  });

  it('an anonymous user can do nothing — there is no way around the demo account download block', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    // A template uploaded by the server — it has no owner, so it is visible to everyone
    const template = await store.importPackage({ name: '템플릿.aasx', package: readAasx(goldenBytes) });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    // Important: previously an unauthenticated call was treated as a "keyless server" and let through (2026-10-06 pre-release review).
    //    On a server with accounts, login comes first
    expect((await api(ask('GET', `/packages/${template.id}/lint`))).status).toBe(401);
    expect((await api(ask('GET', `/packages/${template.id}`))).status).toBe(401);
    expect((await api(ask('POST', '/packages/new', { body: { assetName: 'Sneaky' } }))).status).toBe(401);
  });

  it('the UI can tell what to show — it says demo only for the demo account', async () => {
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

describe('sign-up', () => {
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

  it('Important: closed by default — on an intranet server, anyone must not be able to create accounts', async () => {
    const api = await server();
    const denied = await api(join());
    expect(denied.status).toBe(403);
    expect((await api(ask('GET', '/auth/me'))).body.signupAllowed).toBeUndefined();
  });

  it('when opened, signs up and logs in right away', async () => {
    const api = await server({ role: 'editor' });
    const joined = await api(join({ displayName: '홍길동' }));
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ login: 'hong', displayName: '홍길동', role: 'editor' });
    const me = await api(ask('GET', '/auth/me', { cookie: cookieFrom(joined) }));
    expect(me.body).toMatchObject({ authenticated: true, user: { login: 'hong' } });
  });

  it('Important: signing up does not make you an admin — the operator decides roles', async () => {
    const api = await server({ role: 'viewer' });
    const joined = await api(join());
    expect(joined.body.user.role).toBe('viewer');
    // A role pushed into the body is ignored
    const sneaky = await api(ask('POST', '/auth/signup', {
      body: { login: 'kim', password: '열자가넘는비밀번호입니다', role: 'admin' },
    }));
    expect(sneaky.body.user.role).toBe('viewer');
  });

  it('password rules still apply — the demo account 1234 is an exception the server plants itself', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(join({ password: '1234' }))).status).toBe(400);
  });

  it('says so when the name is already taken — hiding it would make sign-up impossible', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(ask('POST', '/auth/signup', {
      body: { login: 'owner', password: '열자가넘는비밀번호입니다' },
    }))).status).toBe(409);
  });

  it('contact info is optional — sign-up works when it is empty', async () => {
    const api = await server({ role: 'editor' });
    expect((await api(join({ email: '' }))).status).toBe(201);
  });

  it('when given, only its format is checked — no confirmation mail is sent (server with a published privacy policy)', async () => {
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
    // Important: the response does not include contact info — the UI has no use for it
    expect(JSON.stringify(ok.body)).not.toContain('lee@example.com');
  });
});
