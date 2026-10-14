/**
 * Login — looks at the whole gate per request.
 *
 * Important: three things guarded here.
 *   1. The existing token (API key) path still works — only people move to login
 *   2. A failed login **does not reveal whether the account exists**
 *   3. A view-only account can only read — the role actually blocks
 */
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { hashPassword } from '../src/password.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';

function ask(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
): ApiRequest {
  const headers: Record<string, string> = {};
  if (init.cookie) headers['cookie'] = init.cookie;
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  return {
    method: init.method ?? 'GET',
    path,
    query: {},
    headers,
    body: init.body,
  } as ApiRequest;
}

/** Extracts only the session key from Set-Cookie */
function cookieFrom(response: { headers?: Record<string, string> }): string {
  const raw = response.headers?.['set-cookie'] ?? '';
  return raw.split(';')[0] ?? '';
}

async function fresh(): Promise<ReturnType<typeof createApi>> {
  const store = new InMemoryStore();
  await store.init();
  return createApi(store);
}

describe('creating the first admin', () => {
  it('reports setupNeeded when there are no accounts', async () => {
    const api = await fresh();
    const me = await api(ask('/auth/me'));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: false, setupNeeded: true });
  });

  it('is logged in right after creation', async () => {
    const api = await fresh();
    const made = await api(
      ask('/auth/setup', {
        method: 'POST',
        body: { login: 'admin', displayName: '관리자', password: '열자가넘는비밀번호입니다' },
      }),
    );
    expect(made.status).toBe(201);
    expect(made.headers?.['set-cookie']).toContain(SESSION_COOKIE);
    expect(made.body).toMatchObject({ user: { login: 'admin', role: 'admin', level: 'full' } });

    const me = await api(ask('/auth/me', { cookie: cookieFrom(made) }));
    expect(me.body).toMatchObject({ authenticated: true, user: { login: 'admin' } });
  });

  it('Important: closes once an account exists — nobody else may create more admins', async () => {
    const api = await fresh();
    await api(ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }));
    const again = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'hacker', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(again.status).toBe(409);
  });

  it('enforces login name and password rules', async () => {
    const api = await fresh();
    const badLogin = await api(
      ask('/auth/setup', { method: 'POST', body: { login: '한글이름', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(badLogin.status).toBe(400);
    const badPassword = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '짧다' } }),
    );
    expect(badPassword.status).toBe(400);
  });

  it('Important: the response does not include passwordHash', async () => {
    const api = await fresh();
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(JSON.stringify(made.body)).not.toContain('scrypt');
    expect(JSON.stringify(made.body)).not.toContain('passwordHash');
  });
});

describe('login and logout', () => {
  async function withAdmin(): Promise<{ api: ReturnType<typeof createApi>; cookie: string }> {
    const api = await fresh();
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    return { api, cookie: cookieFrom(made) };
  }

  it('logs in with the right password', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.status).toBe(200);
    const me = await api(ask('/auth/me', { cookie: cookieFrom(login) }));
    expect(me.body).toMatchObject({ authenticated: true });
  });

  it('is case-insensitive', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'ADMIN', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.status).toBe(200);
  });

  it('Important: unknown account and wrong password give the same response — account existence must not leak', async () => {
    const { api } = await withAdmin();
    const noSuchUser = await api(
      ask('/auth/login', { method: 'POST', body: { login: '없는사람', password: '열자가넘는비밀번호입니다' } }),
    );
    const wrongPassword = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '아주틀린비밀번호입니다' } }),
    );
    expect(noSuchUser.status).toBe(wrongPassword.status);
    // Only the timestamp differs — apart from that they must match character for character
    const strip = (body: unknown): string =>
      JSON.stringify(body).replace(/"timestamp":"[^"]*"/g, '"timestamp":"-"');
    expect(strip(noSuchUser.body)).toBe(strip(wrongPassword.body));
  });

  it('logout ends the session and clears the cookie', async () => {
    const { api, cookie } = await withAdmin();
    const out = await api(ask('/auth/logout', { method: 'POST', cookie }));
    expect(out.status).toBe(204);
    expect(out.headers?.['set-cookie']).toContain('Max-Age=0');
    const me = await api(ask('/auth/me', { cookie }));
    expect(me.body).toMatchObject({ authenticated: false });
  });

  it('blocks for a while after five failures', async () => {
    const { api } = await withAdmin();
    for (let i = 0; i < 5; i += 1) {
      await api(ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '아주틀린비밀번호입니다' } }));
    }
    const blocked = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(blocked.status).toBe(429);
    // Runs scrypt seven times (a deliberately slow hash). Running the tests all at once can exceed 5 seconds
  }, 30_000);

  it('Important: the cookie is HttpOnly and SameSite=Strict — scripts cannot read it and other sites do not send it', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    const raw = login.headers?.['set-cookie'] ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    // No Secure over plain HTTP — with it the browser drops the cookie
    expect(raw).not.toContain('Secure');
  });
});

describe('Important: the existing token (API key) path still works', () => {
  it('stays open as before without a token — existing tests and installs do not break', async () => {
    const api = await fresh();
    const list = await api(ask('/packages'));
    expect(list.status).toBe(200);
  });

  it('with a token configured, the token gets in (separate from human login)', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['secret-key'], readOnlyTokens: [] } });
    expect((await api(ask('/packages'))).status).toBe(401);
    expect((await api(ask('/packages', { token: 'secret-key' }))).status).toBe(200);
  });

  it('a logged-in person gets in without a token', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['secret-key'], readOnlyTokens: [] } });
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(made.status).toBe(201);
    expect((await api(ask('/packages', { cookie: cookieFrom(made) }))).status).toBe(200);
  });
});

describe('roles', () => {
  it('Important: a viewer can only read — trying to edit gives 403', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'viewer',
      displayName: '검수자',
      role: 'viewer',
      passwordHash: await hashPassword('열자가넘는비밀번호입니다'),
    });
    const api = createApi(store);
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'viewer', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.body).toMatchObject({ user: { level: 'read-only' } });
    const cookie = cookieFrom(login);

    expect((await api(ask('/packages', { cookie }))).status).toBe(200);
    const write = await api(ask('/packages/pkg_1', { method: 'DELETE', cookie }));
    expect(write.status).toBe(403);
  });

  it('an editor can edit', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'editor',
      displayName: '작성자',
      role: 'editor',
      passwordHash: await hashPassword('열자가넘는비밀번호입니다'),
    });
    const api = createApi(store);
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'editor', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.body).toMatchObject({ user: { level: 'full' } });
    // 404 because the package does not exist, but **not 403** — meaning the permission check passed
    const write = await api(ask('/packages/pkg_없음', { method: 'DELETE', cookie: cookieFrom(login) }));
    expect(write.status).not.toBe(403);
  });

  it('a locked account cannot log in, and its existing sessions are ended', async () => {
    const store = new InMemoryStore();
    await store.init();
    const user = await store.createUser({
      login: 'kim',
      displayName: '김',
      role: 'editor',
      passwordHash: await hashPassword('열자가넘는비밀번호입니다'),
    });
    const api = createApi(store);
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '열자가넘는비밀번호입니다' } }),
    );
    const cookie = cookieFrom(login);
    expect((await api(ask('/auth/me', { cookie }))).body).toMatchObject({ authenticated: true });

    await store.updateUser(user.id, { disabled: true });
    expect((await api(ask('/auth/me', { cookie }))).body).toMatchObject({ authenticated: false });
    const again = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(again.status).toBe(401);
  });
});


describe('account management (admin)', () => {
  /** Returns an api logged in as admin and its cookie */
  async function asAdmin(): Promise<{
    api: ReturnType<typeof createApi>;
    store: InMemoryStore;
    cookie: string;
  }> {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    return { api, store, cookie: cookieFrom(made) };
  }

  it('creates an account and it appears in the list', async () => {
    const { api, cookie } = await asAdmin();
    const made = await api(
      ask('/auth/users', {
        method: 'POST',
        cookie,
        body: { login: 'kim', displayName: '김기사', role: 'editor', password: '열자가넘는비밀번호입니다' },
      }),
    );
    expect(made.status).toBe(201);
    const list = await api(ask('/auth/users', { cookie }));
    expect((list.body as { result: { login: string }[] }).result.map((u) => u.login)).toEqual(['admin', 'kim']);
  });

  it('Important: an editor cannot manage accounts', async () => {
    const { api, cookie } = await asAdmin();
    await api(
      ask('/auth/users', {
        method: 'POST',
        cookie,
        body: { login: 'kim', role: 'editor', password: '열자가넘는비밀번호입니다' },
      }),
    );
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '열자가넘는비밀번호입니다' } }),
    );
    const kim = cookieFrom(login);
    expect((await api(ask('/auth/users', { cookie: kim }))).status).toBe(403);
    expect(
      (await api(ask('/auth/users', { method: 'POST', cookie: kim, body: { login: 'x', password: '열자가넘는비밀번호입니다' } })))
        .status,
    ).toBe(403);
  });

  it('rejects a duplicate login name', async () => {
    const { api, cookie } = await asAdmin();
    const again = await api(
      ask('/auth/users', { method: 'POST', cookie, body: { login: 'Admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(again.status).toBe(409);
  });

  it('Important: changing the role ends that person sessions — an open window must not keep editing', async () => {
    const { api, store, cookie } = await asAdmin();
    await api(
      ask('/auth/users', {
        method: 'POST', cookie,
        body: { login: 'kim', role: 'editor', password: '열자가넘는비밀번호입니다' },
      }),
    );
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '열자가넘는비밀번호입니다' } }),
    );
    const kim = cookieFrom(login);
    expect((await api(ask('/auth/me', { cookie: kim }))).body).toMatchObject({ authenticated: true });

    const target = await store.findUserByLogin('kim');
    const patched = await api(
      ask(`/auth/users/${target!.id}`, { method: 'PATCH', cookie, body: { role: 'viewer' } }),
    );
    expect(patched.status).toBe(200);
    expect((await api(ask('/auth/me', { cookie: kim }))).body).toMatchObject({ authenticated: false });
  });

  it('Important: the last admin cannot be demoted or locked — nobody could manage accounts anymore', async () => {
    const { api, store, cookie } = await asAdmin();
    const me = await store.findUserByLogin('admin');
    const demote = await api(
      ask(`/auth/users/${me!.id}`, { method: 'PATCH', cookie, body: { role: 'editor' } }),
    );
    expect(demote.status).toBe(409);
    const lock = await api(
      ask(`/auth/users/${me!.id}`, { method: 'PATCH', cookie, body: { disabled: true } }),
    );
    expect(lock.status).toBe(409);
  });

  it('with two admins, one can be demoted', async () => {
    const { api, store, cookie } = await asAdmin();
    await api(
      ask('/auth/users', {
        method: 'POST', cookie,
        body: { login: 'admin2', role: 'admin', password: '열자가넘는비밀번호입니다' },
      }),
    );
    const second = await store.findUserByLogin('admin2');
    const demote = await api(
      ask(`/auth/users/${second!.id}`, { method: 'PATCH', cookie, body: { role: 'viewer' } }),
    );
    expect(demote.status).toBe(200);
  });

  it('after a password reset, the new password logs in', async () => {
    const { api, store, cookie } = await asAdmin();
    await api(
      ask('/auth/users', {
        method: 'POST', cookie,
        body: { login: 'kim', role: 'editor', password: '열자가넘는비밀번호입니다' },
      }),
    );
    const kim = await store.findUserByLogin('kim');
    await api(
      ask(`/auth/users/${kim!.id}`, { method: 'PATCH', cookie, body: { password: '새로운비밀번호입니다요' } }),
    );
    expect(
      (await api(ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '열자가넘는비밀번호입니다' } })))
        .status,
    ).toBe(401);
    expect(
      (await api(ask('/auth/login', { method: 'POST', body: { login: 'kim', password: '새로운비밀번호입니다요' } })))
        .status,
    ).toBe(200);
  });

  it('editing an unknown account gives 404', async () => {
    const { api, cookie } = await asAdmin();
    expect((await api(ask('/auth/users/user_없음', { method: 'PATCH', cookie, body: { role: 'viewer' } }))).status).toBe(404);
  });
});

describe('changing my own password', () => {
  it('changes only when the current password is correct', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    const cookie = cookieFrom(made);

    const wrong = await api(
      ask('/auth/password', { method: 'POST', cookie, body: { current: '아주틀린비밀번호입니다', next: '새로운비밀번호입니다요' } }),
    );
    expect(wrong.status).toBe(401);

    const ok = await api(
      ask('/auth/password', {
        method: 'POST', cookie,
        body: { current: '열자가넘는비밀번호입니다', next: '새로운비밀번호입니다요' },
      }),
    );
    expect(ok.status).toBe(200);
    // Important: the window that changed it must keep working — it gets a new cookie
    const fresh2 = cookieFrom(ok);
    expect((await api(ask('/auth/me', { cookie: fresh2 }))).body).toMatchObject({ authenticated: true });
    // Old sessions are ended
    expect((await api(ask('/auth/me', { cookie }))).body).toMatchObject({ authenticated: false });
  });

  it('401 when not logged in', async () => {
    const api = await fresh();
    const out = await api(
      ask('/auth/password', { method: 'POST', body: { current: 'a', next: '새로운비밀번호입니다요' } }),
    );
    expect(out.status).toBe(401);
  });
});
