/**
 * Security headers and CSRF origin check (plan A8).
 *
 * Important: what this guards is **the new risk introduced by adding login**. When only tokens
 *    were used the browser never attached credentials automatically, but cookies are sent on their own.
 */
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { clientAddress, crossSiteWrite, demoOutboundAllowed, isHttps, sameCode, securityHeaders, setupCode, setupCodeRequired } from '../src/security.js';

function ask(init: Partial<ApiRequest> & { headers?: Record<string, string> } = {}): ApiRequest {
  return {
    method: init.method ?? 'POST',
    path: init.path ?? '/packages',
    query: {},
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
  } as ApiRequest;
}

describe('security headers', () => {
  it('always present — no type sniffing, no framing, no referrer leak', () => {
    const headers = securityHeaders(false);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
  });

  it("Important: script never gets 'unsafe-inline' — only style does", () => {
    const csp = securityHeaders(false)['content-security-policy']!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('does not block blob: images the UI uses — needed to turn diagrams into PNG', () => {
    expect(securityHeaders(false)['content-security-policy']).toContain("img-src 'self' data: blob:");
  });

  it('Important: HSTS only over HTTPS — if a plain-HTTP server sends it, that address never opens again', () => {
    expect(securityHeaders(false)['strict-transport-security']).toBeUndefined();
    expect(securityHeaders(true)['strict-transport-security']).toContain('max-age=');
  });

  it('recognizes HTTPS even behind a proxy', () => {
    expect(isHttps({}, true)).toBe(true);
    expect(isHttps({ 'x-forwarded-proto': 'https' }, false)).toBe(true);
    // With several proxies the values are joined by commas — the first one is the original connection
    expect(isHttps({ 'x-forwarded-proto': 'https, http' }, false)).toBe(true);
    expect(isHttps({ 'x-forwarded-proto': 'http' }, false)).toBe(false);
    expect(isHttps({}, false)).toBe(false);
  });
});

describe('CSRF — origin check', () => {
  it('passes for the same origin', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'http://192.168.0.10:8080', host: '192.168.0.10:8080' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('rejects writes coming from another site', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://evil.example', host: '192.168.0.10:8080' } }),
      [],
    );
    expect(blocked?.status).toBe(403);
  });

  it('does not check reads — nothing changes', () => {
    const blocked = crossSiteWrite(
      ask({ method: 'GET', headers: { origin: 'https://evil.example', host: 'me:8080' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('passes when Origin is missing — it is not a browser (curl, scripts)', () => {
    expect(crossSiteWrite(ask({ headers: { host: 'me:8080' } }), [])).toBeUndefined();
  });

  it('passes an allowed cross origin (CORS_ORIGIN) — blocking it would defeat the allowance', () => {
    const request = ask({ headers: { origin: 'https://mes.example', host: 'me:8080' } });
    expect(crossSiteWrite(request, [])?.status).toBe(403);
    expect(crossSiteWrite(request, ['https://mes.example'])).toBeUndefined();
    // Important: '*' is for CORS response headers only — it never trusts every site's cookie writes (red-team L11)
    expect(crossSiteWrite(request, ['*'])?.status).toBe(403);
  });

  it('Important: passes even when the proxy rewrites Host — that is the nginx default', () => {
    // nginx's proxy_pass defaults to the upstream address, so Host arrives as 127.0.0.1:8080.
    // Missing this would turn **every write** of a logged-in user into a 403
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

  it('treats a Korean (IDN) domain as the same — the browser sends both sides as punycode', () => {
    // Important: `new URL('https://가.example').host` becomes `xn--...`. In a real request both Origin
    //    and Host are already punycode, so they match — the test just must not mix in the raw form
    const punycode = new URL('https://가나.example').host;
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://가나.example', host: punycode } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });

  it('with several proxies, looks at the first one (the original connection)', () => {
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

  it('still blocks a foreign site even with X-Forwarded-Host', () => {
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

  it('passes when the scheme differs but the host matches — the proxy changes that value', () => {
    const blocked = crossSiteWrite(
      ask({ headers: { origin: 'https://aas.example', host: 'aas.example' } }),
      [],
    );
    expect(blocked).toBeUndefined();
  });
});

describe('CSRF — across the whole gate', () => {
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

  it('blocks even a logged-in cookie when sent from another site', async () => {
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

  it('works as usual for the same origin', async () => {
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

  it('Important: API keys skip the origin check — another site cannot attach that header', async () => {
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

describe('preventing first-admin takeover — setup code', () => {
  it('does not ask on a server bound to this machine only — the person is sitting at the server', () => {
    expect(setupCodeRequired(true)).toBe(false);
    expect(setupCodeRequired(false)).toBe(true);
  });

  it('the code stays fixed within the process and can also be set explicitly', () => {
    expect(setupCode({})).toBe(setupCode({}));
    expect(setupCode({})).toMatch(/^[0-9a-f]{12}$/);
    expect(setupCode({ AAS_SETUP_CODE: '우리회사코드' })).toBe('우리회사코드');
  });

  it('a different length does not throw, it just reports wrong', () => {
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

  it('Important: calling without the code is blocked — the hole where anyone on the same network became admin', async () => {
    const api = await openServer();
    const response = await api(setupBody());
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toContain('설치 코드');
  });

  it('a wrong code is blocked too', async () => {
    const api = await openServer();
    expect((await api(setupBody({ setupCode: '아무거나' }))).status).toBe(403);
  });

  it('a correct code passes', async () => {
    const api = await openServer();
    expect((await api(setupBody({ setupCode: '설치코드1234' }))).status).toBe(201);
  });

  it('does not ask for the code with a full-access API key — the caller already holds the operator secret', async () => {
    const api = await openServer({ auth: { tokens: ['기계키'], readOnlyTokens: [] } });
    const response = await api({
      ...setupBody(),
      headers: { authorization: 'Bearer 기계키' },
    } as ApiRequest);
    expect(response.status).toBe(201);
  });

  it('tells the UI whether it must show one more field', async () => {
    const api = await openServer();
    const me = await api(ask({ method: 'GET', path: '/auth/me' }));
    expect(me.body).toMatchObject({ setupNeeded: true, setupCodeRequired: true });
  });

  it('a server that does not use the code (protected mode) creates the admin right away as before', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(setupBody())).status).toBe(201);
  });
});

describe('Secure flag on the login cookie', () => {
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

  it('is always HttpOnly and SameSite=Strict', async () => {
    const cookie = await loginOn({});
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('Important: no Secure over plain HTTP — with it the cookie is dropped and login fails', async () => {
    expect(await loginOn({})).not.toContain('Secure');
  });

  it('sets Secure when the proxy says HTTPS — deciding once at startup meant it was never set', async () => {
    expect(await loginOn({ 'x-forwarded-proto': 'https' })).toContain('Secure');
  });
});

describe('a keyless server requires login once accounts exist (2026-10-06 pre-release review)', () => {
  // Important: previously, without AAS_TOKEN the server was treated as "open" and let requests through even when accounts existed.
  //    Login was enforced only in the UI, so calling the API directly could read and delete without a cookie.
  it('stays open as before when there are no accounts — single user, before the first admin is created', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(ask({ method: 'GET', path: '/packages' }))).status).toBe(200);
  });

  it('after the first admin is created, cannot read or delete without a cookie', async () => {
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
    // Login status and login itself must stay open — blocking them would lock everyone out
    expect((await api(ask({ method: 'GET', path: '/auth/me' }))).status).toBe(200);
    // A logged-in user works as usual
    expect((await api(ask({ method: 'GET', path: '/packages', headers: { cookie } }))).status).toBe(200);
  });
});

describe('client address — does not trust a client-supplied X-Forwarded-For (2026-10-06)', () => {
  it('uses the last entry appended by the proxy', () => {
    const request = ask({ method: 'GET', path: '/', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } });
    expect(clientAddress(request)).toBe('203.0.113.9');
  });
});

describe('/health — accounts existing means auth is on', () => {
  it('off without accounts, on once they exist', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store);
    expect((await api(ask({ method: 'GET', path: '/health' }))).body).toMatchObject({ auth: 'off' });
    await api(ask({ path: '/auth/setup', body: { login: 'admin', password: '열자가넘는비밀번호입니다' } }));
    expect((await api(ask({ method: 'GET', path: '/health' }))).body).toMatchObject({ auth: 'on' });
  });
});

describe('Important: outbound connections in the demo — everything but the virtual PLC is blocked (SSRF, 2026-10-08)', () => {
  it('the virtual PLC address goes through', () => {
    expect(demoOutboundAllowed('opc.tcp://127.0.0.1:14850/UA/Simulator', 14850)).toBe(true);
    expect(demoOutboundAllowed('opc.tcp://localhost:14850', 14850)).toBe(true);
    expect(demoOutboundAllowed('opc.tcp://[::1]:14850/UA/Simulator', 14850)).toBe(true);
  });
  it('internal network, other ports, hostnames, and other protocols are blocked', () => {
    for (const endpoint of [
      'opc.tcp://192.168.0.1:4840',
      'opc.tcp://10.0.0.5:14850',
      'opc.tcp://127.0.0.1:5432',
      'opc.tcp://127.0.0.1',
      'opc.tcp://db:5432',
      'opc.tcp://127.0.0.1.nip.io:14850',
      'opc.tcp://localhost.evil.com:14850',
      'opc.tcp://user@127.0.0.1:14850',
      'http://127.0.0.1:14850',
      '',
    ]) expect(demoOutboundAllowed(endpoint, 14850), endpoint).toBe(false);
  });
});
