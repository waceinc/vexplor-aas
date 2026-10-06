/**
 * 보안 머리글 · CSRF 원점 검사(계획 A8).
 *
 * 🔴 여기서 지키려는 것은 **로그인을 들이면서 새로 생긴 위험**이다. 토큰만 쓰던 때는
 *    브라우저가 자격을 자동으로 싣지 않았지만, 쿠키는 알아서 실린다.
 */
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { clientAddress, crossSiteWrite, isHttps, sameCode, securityHeaders, setupCode, setupCodeRequired } from '../src/security.js';

function ask(init: Partial<ApiRequest> & { headers?: Record<string, string> } = {}): ApiRequest {
  return {
    method: init.method ?? 'POST',
    path: init.path ?? '/packages',
    query: {},
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
  } as ApiRequest;
}

describe('보안 머리글', () => {
  it('언제나 붙는 것 — 종류 추측 금지 · 끼워넣기 금지 · 주소 유출 금지', () => {
    const headers = securityHeaders(false);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
  });

  it("🔴 script에는 'unsafe-inline'을 주지 않는다 — style에만 준다", () => {
    const csp = securityHeaders(false)['content-security-policy']!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('화면이 쓰는 blob: 그림을 막지 않는다 — 다이어그램을 PNG로 바꿀 때 쓴다', () => {
    expect(securityHeaders(false)['content-security-policy']).toContain("img-src 'self' data: blob:");
  });

  it('🔴 HSTS는 HTTPS일 때만 — 평문 서버가 말하면 그 주소가 영영 안 열린다', () => {
    expect(securityHeaders(false)['strict-transport-security']).toBeUndefined();
    expect(securityHeaders(true)['strict-transport-security']).toContain('max-age=');
  });

  it('프록시 뒤에서도 HTTPS를 알아본다', () => {
    expect(isHttps({}, true)).toBe(true);
    expect(isHttps({ 'x-forwarded-proto': 'https' }, false)).toBe(true);
    // 프록시가 여럿이면 쉼표로 이어 붙는다 — 맨 앞이 원래 접속이다
    expect(isHttps({ 'x-forwarded-proto': 'https, http' }, false)).toBe(true);
    expect(isHttps({ 'x-forwarded-proto': 'http' }, false)).toBe(false);
    expect(isHttps({}, false)).toBe(false);
  });
});

describe('CSRF — 원점 검사', () => {
  it('같은 출처면 통과한다', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'http://192.168.0.10:8080', host: '192.168.0.10:8080' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('다른 사이트에서 온 쓰기는 거절한다', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://evil.example', host: '192.168.0.10:8080' } }),
      [],
    );
    expect(blocked?.status).toBe(403);
  });

  it('읽기는 따지지 않는다 — 바꾸는 것이 없다', () => {
    const blocked = crossSiteWrite(
      ask({ method: 'GET', headers: { origin: 'https://evil.example', host: 'me:8080' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('Origin이 없으면 통과한다 — 브라우저가 아닌 것(curl·스크립트)이다', () => {
    expect(crossSiteWrite(ask({ headers: { host: 'me:8080' } }), [])).toBeUndefined();
  });

  it('허용한 교차 출처(CORS_ORIGIN)는 통과한다 — 막으면 허용의 뜻이 없다', () => {
    const request = ask({ headers: { origin: 'https://mes.example', host: 'me:8080' } });
    expect(crossSiteWrite(request, [])?.status).toBe(403);
    expect(crossSiteWrite(request, ['https://mes.example'])).toBeUndefined();
    expect(crossSiteWrite(request, ['*'])).toBeUndefined();
  });

  it('🔴 프록시가 Host를 바꿔 써도 통과한다 — nginx 기본값이 그렇다', () => {
    // nginx는 proxy_pass 기본값이 업스트림 주소라 Host가 127.0.0.1:8080으로 온다.
    // 이것을 못 보면 로그인한 사람의 **모든 쓰기**가 403이 된다
    const blocked = crossSiteWrite(
      ask({
        headers: {
          origin: 'https://aas.corp.example',
          host: '127.0.0.1:8080',
          'x-forwarded-host': 'aas.corp.example',
        },
      }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('한글 도메인도 같은 것으로 본다 — 브라우저가 양쪽 다 punycode로 보낸다', () => {
    // 🔴 `new URL('https://가.example').host`는 `xn--...`로 바뀐다. 실제 요청은 Origin도
    //    Host도 이미 punycode라 어긋나지 않는다 — 시험에서만 날것을 섞지 않으면 된다
    const punycode = new URL('https://가나.example').host;
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://가나.example', host: punycode } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('프록시가 여럿이면 맨 앞(원래 접속)을 본다', () => {
    const blocked = crossSiteWrite(
      ask({
        headers: {
          origin: 'https://aas.corp.example',
          host: '127.0.0.1:8080',
          'x-forwarded-host': 'aas.corp.example, inner.local',
        },
      }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('X-Forwarded-Host가 있어도 남의 사이트는 여전히 막힌다', () => {
    const blocked = crossSiteWrite(
      ask({
        headers: {
          origin: 'https://evil.example',
          host: '127.0.0.1:8080',
          'x-forwarded-host': 'aas.corp.example',
        },
      }),
      [],
    );
    expect(blocked?.status).toBe(403);
  });

  it('스킴이 달라도 host가 같으면 통과한다 — 프록시가 바꾸는 값이다', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://aas.example', host: 'aas.example' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });
});

describe('CSRF — 문 전체에서', () => {
  async function loggedIn(): Promise<{ api: ReturnType<typeof createApi>; cookie: string }> {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['기계키'], readOnlyTokens: [] } });
    const made = await api(
      ask({
        path: '/auth/setup',
        body: { login: 'admin', password: '열자가넘는비밀번호입니다' },
      }),
    );
    expect(made.status).toBe(201);
    return { api, cookie: (made.headers?.['set-cookie'] ?? '').split(';')[0] ?? '' };
  }

  it('로그인한 쿠키라도 남의 사이트에서 보내면 막힌다', async () => {
    const { api, cookie } = await loggedIn();
    const response = await api(
      ask({
        path: '/packages/new',
        body: { assetName: 'X' },
        headers: { cookie, origin: 'https://evil.example', host: 'me:8080' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('같은 출처면 평소대로 된다', async () => {
    const { api, cookie } = await loggedIn();
    const response = await api(
      ask({
        path: '/packages/new',
        body: { assetName: 'X' },
        headers: { cookie, origin: 'http://me:8080', host: 'me:8080' },
      }),
    );
    expect(response.status).toBe(201);
  });

  it('🔴 API 키는 원점을 따지지 않는다 — 남의 사이트가 붙일 수 없는 헤더다', async () => {
    const { api } = await loggedIn();
    const response = await api(
      ask({
        path: '/packages/new',
        body: { assetName: 'X' },
        headers: { authorization: 'Bearer 기계키', origin: 'https://partner.example', host: 'me:8080' },
      }),
    );
    expect(response.status).toBe(201);
  });
});

describe('첫 관리자 선점 막기 — 설치 코드', () => {
  it('이 컴퓨터에서만 열린 서버는 묻지 않는다 — 서버 앞에 앉은 사람이다', () => {
    expect(setupCodeRequired(true)).toBe(false);
    expect(setupCodeRequired(false)).toBe(true);
  });

  it('코드는 프로세스 안에서 변하지 않고, 직접 정할 수도 있다', () => {
    expect(setupCode({})).toBe(setupCode({}));
    expect(setupCode({})).toMatch(/^[0-9a-f]{12}$/);
    expect(setupCode({ AAS_SETUP_CODE: '우리회사코드' })).toBe('우리회사코드');
  });

  it('길이가 달라도 터지지 않고 틀렸다고만 한다', () => {
    expect(sameCode('abcdef', 'abcdef')).toBe(true);
    expect(sameCode('abcdef', 'abcde')).toBe(false);
    expect(sameCode('abcdef', '')).toBe(false);
  });

  async function openServer(options: { auth?: { tokens: string[]; readOnlyTokens: string[] } } = {}) {
    const store = new InMemoryStore();
    await store.init();
    return createApi(store, {
      setupCode: '설치코드1234',
      ...(options.auth ? { auth: options.auth } : {}),
    });
  }

  const setupBody = (extra: Record<string, unknown> = {}): ApiRequest =>
    ask({
      path: '/auth/setup',
      body: { login: 'admin', password: '열자가넘는비밀번호입니다', ...extra },
    });

  it('🔴 코드 없이 부르면 막힌다 — 같은 망의 아무나 관리자가 되던 구멍', async () => {
    const api = await openServer();
    const response = await api(setupBody());
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toContain('설치 코드');
  });

  it('틀린 코드도 막힌다', async () => {
    const api = await openServer();
    expect((await api(setupBody({ setupCode: '아무거나' }))).status).toBe(403);
  });

  it('맞는 코드면 통과한다', async () => {
    const api = await openServer();
    expect((await api(setupBody({ setupCode: '설치코드1234' }))).status).toBe(201);
  });

  it('전체 권한 API 키를 들고 있으면 코드를 묻지 않는다 — 이미 운영자의 비밀을 쥐었다', async () => {
    const api = await openServer({ auth: { tokens: ['기계키'], readOnlyTokens: [] } });
    const response = await api({
      ...setupBody(),
      headers: { authorization: 'Bearer 기계키' },
    } as ApiRequest);
    expect(response.status).toBe(201);
  });

  it('화면이 칸을 하나 더 보여야 하는지 알려 준다', async () => {
    const api = await openServer();
    const me = await api(ask({ method: 'GET', path: '/auth/me' }));
    expect(me.body).toMatchObject({ setupNeeded: true, setupCodeRequired: true });
  });

  it('코드를 쓰지 않는 서버(보호 모드)는 예전처럼 바로 만든다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(setupBody())).status).toBe(201);
  });
});

describe('로그인 쿠키의 Secure', () => {
  async function loginOn(headers: Record<string, string>): Promise<string> {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    const made = await api({
      method: 'POST',
      path: '/auth/setup',
      query: {},
      headers,
      body: { login: 'admin', password: '열자가넘는비밀번호입니다' },
    } as ApiRequest);
    expect(made.status).toBe(201);
    return made.headers?.['set-cookie'] ?? '';
  }

  it('언제나 HttpOnly·SameSite=Strict다', async () => {
    const cookie = await loginOn({});
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('🔴 평문으로 들어오면 Secure를 붙이지 않는다 — 붙이면 쿠키가 버려져 로그인이 안 된다', async () => {
    expect(await loginOn({})).not.toContain('Secure');
  });

  it('프록시가 HTTPS라고 하면 Secure를 붙인다 — 기동 때 한 번 정하던 탓에 한 번도 안 붙었다', async () => {
    expect(await loginOn({ 'x-forwarded-proto': 'https' })).toContain('Secure');
  });
});

describe('키 없는 서버도 계정이 생기면 로그인부터 (2026-10-06 출시 전 검토)', () => {
  // 🔴 예전에는 AAS_TOKEN이 없으면 계정이 있어도 「열린 서버」로 보고 통과시켰다.
  //    로그인은 화면에만 걸려 있어, API를 직접 부르면 쿠키 없이 읽고 지울 수 있었다.
  it('계정이 없을 때는 예전처럼 열려 있다 — 혼자 쓰기 · 첫 관리자 만들기 전', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(ask({ method: 'GET', path: '/packages' }))).status).toBe(200);
  });

  it('첫 관리자를 만든 뒤에는 쿠키 없이 읽지도 지우지도 못한다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    const made = await api(ask({ path: '/auth/setup', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }));
    expect(made.status).toBe(201);
    const cookie = (made.headers?.['set-cookie'] ?? '').split(';')[0] ?? '';
    const created = await api(ask({ path: '/packages/new', body: { assetName: 'Press' }, headers: { cookie } }));
    expect(created.status).toBe(201);
    const id = (created.body as { packageId: string }).packageId;

    expect((await api(ask({ method: 'GET', path: '/packages' }))).status).toBe(401);
    expect((await api(ask({ method: 'GET', path: `/packages/${id}` }))).status).toBe(401);
    expect((await api(ask({ method: 'DELETE', path: `/packages/${id}` }))).status).toBe(401);
    // 로그인 상태 확인·로그인은 열려 있어야 한다 — 막으면 아무도 못 들어온다
    expect((await api(ask({ method: 'GET', path: '/auth/me' }))).status).toBe(200);
    // 로그인한 사람은 그대로 쓴다
    expect((await api(ask({ method: 'GET', path: '/packages', headers: { cookie } }))).status).toBe(200);
  });
});

describe('접속 주소 — 손님이 적어 보낸 X-Forwarded-For를 믿지 않는다 (2026-10-06)', () => {
  it('프록시가 덧붙인 마지막 칸을 쓴다', () => {
    const request = ask({ method: 'GET', path: '/', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } });
    expect(clientAddress(request)).toBe('203.0.113.9');
  });
});

describe('/health — 계정이 있으면 인증이 켜진 것이다', () => {
  it('계정이 없으면 off, 생기면 on', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(ask({ method: 'GET', path: '/health' }))).body).toMatchObject({ auth: 'off' });
    await api(ask({ path: '/auth/setup', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }));
    expect((await api(ask({ method: 'GET', path: '/health' }))).body).toMatchObject({ auth: 'on' });
  });
});
