/**
 * Places that **can actually break** once the trial server is public.
 *
 * Five found in the expert review (2026-10-04). Not features but **ways operations break**.
 *   ① The trial account changing its own password and killing the public server
 *   ② No account deletion, so a "please delete me" request cannot be honored
 *   ③ Audit records disappearing along with a deleted account
 *   ④ Collecting contact details without a privacy policy
 *   ⑤ Bots creating accounts without limit
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

describe('Important: the trial account cannot change itself', () => {
  it('cannot change its password — changing it kills the public trial server', async () => {
    const { api, demoCookie } = await demoServer();
    const tried = await api(
      ask('POST', '/auth/password', {
        body: { current: '1234', next: '내가정한열자이상비밀번호' },
        cookie: demoCookie,
      }),
    );
    expect(tried.status).toBe(403);
    // Even after the block the original password still works — the next visitor must be able to use it
    expect((await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' } }))).status).toBe(200);
  });

  it('cannot delete itself — deleting it locks out the next person', async () => {
    const { api, demoCookie } = await demoServer();
    expect((await api(ask('DELETE', '/auth/me', { cookie: demoCookie }))).status).toBe(403);
  });

  it('registered users can do both — only the shared account is blocked', async () => {
    const { api } = await demoServer();
    const joined = await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } }));
    const cookie = cookieFrom(joined);
    const changed = await api(
      ask('POST', '/auth/password', { body: { current: PASSWORD, next: '새로정한열자이상비밀번호' }, cookie }),
    );
    expect(changed.status).toBe(200);
  });
});

describe('account deletion', () => {
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

  it('once deleted, that account cannot log in — this is deletion, not locking', async () => {
    const { api } = await withOwner();
    const joined = await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } }));
    expect((await api(ask('DELETE', '/auth/me', { cookie: cookieFrom(joined) }))).status).toBe(204);
    expect((await api(ask('POST', '/auth/login', { body: { login: 'hong', password: PASSWORD } }))).status).toBe(401);
  });

  it('Important: "who changed it" survives deletion — audit records must not vanish retroactively', async () => {
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

  it('Important: deleting an account also deletes the files that person uploaded — other people\'s files stay (2026-10-06)', async () => {
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

  it('the last admin cannot be deleted — otherwise nobody can manage accounts', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as Api;
    const made = await api(ask('POST', '/auth/setup', { body: { login: 'owner', password: PASSWORD } }));
    expect((await api(ask('DELETE', '/auth/me', { cookie: cookieFrom(made) }))).status).toBe(409);
  });
});

describe('Important: no contact details are accepted without a privacy policy', () => {
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

  it('rejects contact details sent without a policy — if we cannot state how they are used, we do not take them', async () => {
    const api = await server();
    expect((await api(join({ email: 'hong@example.com' }))).status).toBe(400);
    // Leave it empty and sign-up works — it must be usable without contact details
    expect((await api(join())).status).toBe(201);
  });

  it('accepts them once a policy is posted, and the UI picks up that URL', async () => {
    const api = await server('https://example.com/privacy');
    // A server with a posted policy collects name · company · email together with consent (2026-10-06)
    expect((await api(join({ email: 'hong@example.com' }))).status).toBe(400);
    expect(
      (await api(join({ email: 'hong@example.com', displayName: '홍길동', company: 'WACE', agreed: true }))).status,
    ).toBe(201);
    expect((await api(ask('GET', '/auth/me'))).body.privacyUrl).toBe('https://example.com/privacy');
  });
});

describe('sign-up rate limit', () => {
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

  it('blocks too many sign-ups from the same source', async () => {
    const api = await withThrottle(100, 3);
    for (let n = 0; n < 3; n += 1) expect((await api(join(n, '203.0.113.9'))).status).toBe(201);
    expect((await api(join(9, '203.0.113.9'))).status).toBe(429);
  });

  it('Important: there is also a global cap — addresses can be spoofed, so they alone cannot stop it', async () => {
    const api = await withThrottle(2, 100);
    expect((await api(join(1, '198.51.100.1'))).status).toBe(201);
    expect((await api(join(2, '198.51.100.2'))).status).toBe(201);
    // Even changing the address each time still hits the global cap
    expect((await api(join(3, '198.51.100.3'))).status).toBe(429);
  });

  it('failed attempts are not counted — no account was created, so there is no reason to count them', async () => {
    const api = await withThrottle(100, 2);
    const bad = ask('POST', '/auth/signup', { body: { login: 'hong', password: '짧다' }, from: '203.0.113.1' });
    for (let n = 0; n < 5; n += 1) expect((await api(bad)).status).toBe(400);
    expect(
      (await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD }, from: '203.0.113.1' })))
        .status,
    ).toBe(201);
  });
});

describe('outsiders cannot break the public server (2026-10-06 security review)', () => {
  it('Important: no number of wrong passwords locks the trial account — the hole that locked out every visitor', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    for (let i = 0; i < 8; i += 1) {
      await api(ask('POST', '/auth/login', { body: { login: 'admin', password: 'wrong' }, from: '203.0.113.9' }));
    }
    // Visitors behind the same company network (same address) must not be blocked either — trial account attempts are not counted at all
    const visitor = await api(ask('POST', '/auth/login', { body: { login: 'admin', password: '1234' }, from: '203.0.113.9' }));
    expect(visitor.status).toBe(200);
    // Runs scrypt close to ten times (deliberately slow hash) — running tests all at once exceeds 5 seconds
  }, 30_000);

  it('caps the number of files one person can upload — they cannot fill the disk', async () => {
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

describe('sign-up — name · company · email · consent (server with a posted privacy policy, 2026-10-06)', () => {
  async function server(): Promise<{ api: Api; store: InMemoryStore; adminCookie: string }> {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { signup: { role: 'editor', privacyUrl: '/privacy.html' } }) as Api;
    const adminCookie = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    return { api, store, adminCookie };
  }
  const full = { login: 'kim', password: PASSWORD, displayName: '김철수', company: 'WACE', email: 'kim@example.com', agreed: true };

  it('rejects if either name or email is empty', async () => {
    const { api } = await server();
    for (const missing of ['displayName', 'email'] as const) {
      const reply = await api(ask('POST', '/auth/signup', { body: { ...full, [missing]: '' } }));
      expect(reply.status).toBe(400);
    }
  });

  it('sign-up works with company left empty (2026-10-08 user request)', async () => {
    const { api, store } = await server();
    expect((await api(ask('POST', '/auth/signup', { body: { ...full, company: '' } }))).status).toBe(201);
    expect((await store.findUserByLogin('kim'))?.company).toBeUndefined();
  });

  it('Important: rejects without consent — does not trust the on-screen checkbox alone', async () => {
    const { api } = await server();
    expect((await api(ask('POST', '/auth/signup', { body: { ...full, agreed: false } }))).status).toBe(400);
  });

  it('on acceptance the server records the consent time, and company/email are visible only to admins', async () => {
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
    // The registered user (editor) cannot see other people's list
    expect((await api(ask('GET', '/auth/users', { cookie: cookieFrom(joined) }))).status).toBe(403);
  });

  it('a server without a privacy policy does not accept company or email', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { signup: { role: 'editor' } }) as Api;
    expect((await api(ask('POST', '/auth/signup', { body: { login: 'lee', password: PASSWORD, company: 'X' } }))).status).toBe(400);
    expect((await api(ask('POST', '/auth/signup', { body: { login: 'lee', password: PASSWORD } }))).status).toBe(201);
  });
});

describe('my account settings — editing my info (2026-10-08 user request)', () => {
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

  it('changes display name · company · email, and my screen shows them as is', async () => {
    const { api, store, boss } = await server();
    const reply = await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: 'WACE 관리자', company: '와이스', email: 'admin@example.com' } }));
    expect(reply.status).toBe(200);
    expect(reply.body.user).toMatchObject({ displayName: 'WACE 관리자', company: '와이스', email: 'admin@example.com', role: 'admin' });
    const me = await api(ask('GET', '/auth/me', { cookie: boss }));
    expect(me.body.user).toMatchObject({ displayName: 'WACE 관리자', company: '와이스' });
    // An empty value clears it
    await api(ask('PATCH', '/auth/me', { cookie: boss, body: { company: '' } }));
    expect((await store.findUserByLogin('boss'))?.company).toBeUndefined();
  });

  it('Important: role and login name cannot be changed here — they are ignored if sent', async () => {
    const { api, store, boss } = await server();
    await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: '나', role: 'viewer', login: 'other' } }));
    const saved = await store.findUserByLogin('boss');
    expect(saved?.role).toBe('admin');
    expect(await store.findUserByLogin('other')).toBeUndefined();
  });

  it('rejects invalid values · the demo account · users not logged in', async () => {
    const { api, boss, demo } = await server();
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: { displayName: '' } }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: { email: '골뱅이없음' } }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: boss, body: {} }))).status).toBe(400);
    expect((await api(ask('PATCH', '/auth/me', { cookie: demo, body: { displayName: '해커' } }))).status).toBe(403);
    expect((await api(ask('PATCH', '/auth/me', { body: { displayName: '누구' } }))).status).toBe(401);
  });
});

describe('account deletion by an admin (2026-10-06 user request)', () => {
  async function server(): Promise<{ api: Api; store: InMemoryStore; boss: string }> {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    await store.createUser({ login: 'boss', displayName: '운영자', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as Api;
    const boss = cookieFrom(await api(ask('POST', '/auth/login', { body: { login: 'boss', password: PASSWORD } })));
    return { api, store, boss };
  }

  it('deleting removes that person together with the files they uploaded', async () => {
    const { api, store, boss } = await server();
    const hong = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    expect((await api(ask('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, cookie: hong }))).status).toBe(201);
    const id = (await store.findUserByLogin('hong'))!.id;

    const reply = await api(ask('DELETE', `/auth/users/${id}`, { cookie: boss }));
    expect(reply.status).toBe(200);
    expect(reply.body.files).toBe(1);
    expect(await store.findUserByLogin('hong')).toBeUndefined();
    expect((await store.listPackages()).items.filter((item) => item.owner === `user:${id}`)).toHaveLength(0);
    // That person's login is cut off immediately too
    expect((await api(ask('GET', '/auth/me', { cookie: hong }))).body.authenticated).toBe(false);
  });

  it('Important: what is blocked — yourself · the trial account · non-admins', async () => {
    const { api, store, boss } = await server();
    const me = (await store.findUserByLogin('boss'))!.id;
    expect((await api(ask('DELETE', `/auth/users/${me}`, { cookie: boss }))).status).toBe(409);
    const demo = (await store.findUserByLogin('admin'))!.id;
    expect((await api(ask('DELETE', `/auth/users/${demo}`, { cookie: boss }))).status).toBe(403);
    const hong = cookieFrom(await api(ask('POST', '/auth/signup', { body: { login: 'hong', password: PASSWORD } })));
    expect((await api(ask('DELETE', `/auth/users/${me}`, { cookie: hong }))).status).toBe(403);
  });
});

describe('Important: even an admin cannot change the trial account (2026-10-06 security review)', () => {
  it('raising its role to admin would make anyone logging in as admin/1234 an admin — blocked', async () => {
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
    // The admin list marks it as the trial account — the UI drops the buttons
    const list = await api(ask('GET', '/auth/users', { cookie: boss }));
    expect(list.body.result.find((user: { login: string }) => user.login === 'admin').demo).toBe(true);
  });
});
