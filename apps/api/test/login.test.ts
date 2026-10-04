/**
 * 로그인 — 문 전체를 요청 단위로 본다.
 *
 * 🔴 여기서 지키는 것 셋.
 *   ① 기존 토큰(API 키) 경로가 그대로 산다 — 사람만 로그인으로 옮긴다
 *   ② 로그인 실패가 **계정의 존재를 알려 주지 않는다**
 *   ③ 보기 전용 계정은 읽기만 — 역할이 실제로 막는다
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

/** Set-Cookie에서 세션 열쇠만 꺼낸다 */
function cookieFrom(response: { headers?: Record<string, string> }): string {
  const raw = response.headers?.['set-cookie'] ?? '';
  return raw.split(';')[0] ?? '';
}

async function fresh(): Promise<ReturnType<typeof createApi>> {
  const store = new InMemoryStore();
  await store.init();
  return createApi(store);
}

describe('첫 관리자 만들기', () => {
  it('계정이 없으면 setupNeeded로 알린다', async () => {
    const api = await fresh();
    const me = await api(ask('/auth/me'));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: false, setupNeeded: true });
  });

  it('만들면 바로 로그인된 상태가 된다', async () => {
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

  it('🔴 계정이 생긴 뒤에는 닫힌다 — 누구나 관리자를 더 만들면 안 된다', async () => {
    const api = await fresh();
    await api(ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }));
    const again = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'hacker', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(again.status).toBe(409);
  });

  it('로그인 이름·비밀번호 규칙을 지킨다', async () => {
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

  it('🔴 응답에 passwordHash가 실리지 않는다', async () => {
    const api = await fresh();
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(JSON.stringify(made.body)).not.toContain('scrypt');
    expect(JSON.stringify(made.body)).not.toContain('passwordHash');
  });
});

describe('로그인·로그아웃', () => {
  async function withAdmin(): Promise<{ api: ReturnType<typeof createApi>; cookie: string }> {
    const api = await fresh();
    const made = await api(
      ask('/auth/setup', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    return { api, cookie: cookieFrom(made) };
  }

  it('맞는 비밀번호로 로그인된다', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.status).toBe(200);
    const me = await api(ask('/auth/me', { cookie: cookieFrom(login) }));
    expect(me.body).toMatchObject({ authenticated: true });
  });

  it('대소문자를 가리지 않는다', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'ADMIN', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(login.status).toBe(200);
  });

  it('🔴 없는 계정과 틀린 비밀번호가 같은 응답이다 — 계정의 존재가 새면 안 된다', async () => {
    const { api } = await withAdmin();
    const noSuchUser = await api(
      ask('/auth/login', { method: 'POST', body: { login: '없는사람', password: '열자가넘는비밀번호입니다' } }),
    );
    const wrongPassword = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '아주틀린비밀번호입니다' } }),
    );
    expect(noSuchUser.status).toBe(wrongPassword.status);
    // 시각만 다르다 — 그것을 빼면 글자 하나까지 같아야 한다
    const strip = (body: unknown): string =>
      JSON.stringify(body).replace(/"timestamp":"[^"]*"/g, '"timestamp":"-"');
    expect(strip(noSuchUser.body)).toBe(strip(wrongPassword.body));
  });

  it('로그아웃하면 세션이 끊기고 쿠키가 지워진다', async () => {
    const { api, cookie } = await withAdmin();
    const out = await api(ask('/auth/logout', { method: 'POST', cookie }));
    expect(out.status).toBe(204);
    expect(out.headers?.['set-cookie']).toContain('Max-Age=0');
    const me = await api(ask('/auth/me', { cookie }));
    expect(me.body).toMatchObject({ authenticated: false });
  });

  it('다섯 번 틀리면 잠시 막힌다', async () => {
    const { api } = await withAdmin();
    for (let i = 0; i < 5; i += 1) {
      await api(ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '아주틀린비밀번호입니다' } }));
    }
    const blocked = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(blocked.status).toBe(429);
    // scrypt를 일곱 번 돈다(일부러 느린 해시다). 시험을 한꺼번에 돌리면 5초를 넘길 때가 있다
  }, 30_000);

  it('🔴 쿠키는 HttpOnly·SameSite=Strict다 — 스크립트가 못 읽고 남의 사이트에서 안 실린다', async () => {
    const { api } = await withAdmin();
    const login = await api(
      ask('/auth/login', { method: 'POST', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }),
    );
    const raw = login.headers?.['set-cookie'] ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    // 평문 HTTP에서는 Secure를 붙이지 않는다 — 붙이면 브라우저가 쿠키를 버린다
    expect(raw).not.toContain('Secure');
  });
});

describe('🔴 기존 토큰(API 키) 경로는 그대로 산다', () => {
  it('토큰이 없으면 예전처럼 열려 있다 — 기존 테스트·설치판이 안 깨진다', async () => {
    const api = await fresh();
    const list = await api(ask('/packages'));
    expect(list.status).toBe(200);
  });

  it('토큰을 설정하면 토큰으로 들어간다(사람 로그인과 별개)', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['secret-key'], readOnlyTokens: [] } });
    expect((await api(ask('/packages'))).status).toBe(401);
    expect((await api(ask('/packages', { token: 'secret-key' }))).status).toBe(200);
  });

  it('로그인한 사람은 토큰 없이도 들어간다', async () => {
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

describe('역할', () => {
  it('🔴 보기 전용(viewer)은 읽기만 — 고치려 하면 403', async () => {
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

  it('편집자(editor)는 고칠 수 있다', async () => {
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
    // 없는 패키지라 404지만 **403은 아니다** — 권한은 통과했다는 뜻
    const write = await api(ask('/packages/pkg_없음', { method: 'DELETE', cookie: cookieFrom(login) }));
    expect(write.status).not.toBe(403);
  });

  it('잠근 계정은 로그인도 안 되고, 이미 있던 세션도 끊긴다', async () => {
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


describe('계정 관리 (관리자)', () => {
  /** 관리자로 로그인된 api와 쿠키를 돌려준다 */
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

  it('계정을 만들고 목록에 나온다', async () => {
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

  it('🔴 편집자는 계정을 다룰 수 없다', async () => {
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

  it('같은 로그인 이름은 거절한다', async () => {
    const { api, cookie } = await asAdmin();
    const again = await api(
      ask('/auth/users', { method: 'POST', cookie, body: { login: 'Admin', password: '열자가넘는비밀번호입니다' } }),
    );
    expect(again.status).toBe(409);
  });

  it('🔴 역할을 바꾸면 그 사람의 세션이 끊긴다 — 열려 있던 창이 계속 편집하면 안 된다', async () => {
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

  it('🔴 마지막 관리자는 강등·잠금할 수 없다 — 아무도 계정을 다룰 수 없게 된다', async () => {
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

  it('관리자가 둘이면 한 명은 강등할 수 있다', async () => {
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

  it('비밀번호를 초기화하면 새 것으로 로그인된다', async () => {
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

  it('없는 계정을 고치면 404', async () => {
    const { api, cookie } = await asAdmin();
    expect((await api(ask('/auth/users/user_없음', { method: 'PATCH', cookie, body: { role: 'viewer' } }))).status).toBe(404);
  });
});

describe('내 비밀번호 바꾸기', () => {
  it('지금 비밀번호가 맞아야 바뀐다', async () => {
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
    // 🔴 바꾼 창은 이어서 쓸 수 있어야 한다 — 새 쿠키를 준다
    const fresh2 = cookieFrom(ok);
    expect((await api(ask('/auth/me', { cookie: fresh2 }))).body).toMatchObject({ authenticated: true });
    // 옛 세션은 끊긴다
    expect((await api(ask('/auth/me', { cookie }))).body).toMatchObject({ authenticated: false });
  });

  it('로그인하지 않았으면 401', async () => {
    const api = await fresh();
    const out = await api(
      ask('/auth/password', { method: 'POST', body: { current: 'a', next: '새로운비밀번호입니다요' } }),
    );
    expect(out.status).toBe(401);
  });
});
