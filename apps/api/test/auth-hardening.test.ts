/**
 * Account and session hardening from the 2026-10-16 red-team review.
 *
 *   M2  — a read-only API key must not read account details meant for admins
 *   L1  — guessing one login from many addresses must not lock its owner out everywhere
 *   L2  — a cookie write without a usable Origin is not let through blindly
 *   L3  — two simultaneous "create the first admin" calls must not make two admins
 *   L10 — private workspaces without any way to tell people apart are refused, not silently shared
 *   L11 — `CORS_ORIGIN=*` is about response headers, not about trusting every site's writes
 */
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { hashPassword } from '../src/password.js';
import { crossSiteWrite } from '../src/security.js';
import { LoginThrottle } from '../src/session.js';

type Reply = { status: number; headers: Record<string, string>; body: any };

function ask(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; token?: string; cookie?: string } = {},
): ApiRequest {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.cookie) headers['cookie'] = init.cookie;
  return { method, path, query: {}, headers, ...(init.body === undefined ? {} : { body: init.body }) } as ApiRequest;
}

const PASSWORD = 'correct-horse-battery';
const cookieFrom = (reply: Reply): string => (reply.headers['set-cookie'] ?? '').split(';')[0] ?? '';

describe('M2 — admin-only account routes refuse a read-only API key', () => {
  async function server() {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({
      login: 'bob', displayName: 'Bob', role: 'editor', passwordHash: await hashPassword('x'.repeat(12)),
      email: 'bob@corp.example', company: 'ACME',
    });
    const api = createApi(store, { auth: { tokens: ['full-key'], readOnlyTokens: ['ro-key'] } }) as (r: ApiRequest) => Promise<Reply>;
    return api;
  }

  it('GET /auth/users with a read-only key is 403 and leaks no contact details', async () => {
    const api = await server();
    const reply = await api(ask('GET', '/auth/users', { token: 'ro-key' }));
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain('bob@corp.example');
  });

  it('a full-access key still manages accounts (machine operators keep working)', async () => {
    const api = await server();
    expect((await api(ask('GET', '/auth/users', { token: 'full-key' }))).status).toBe(200);
  });

  it('a truly open server (no keys, no accounts) still lists the (empty) account list', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as (r: ApiRequest) => Promise<Reply>;
    expect((await api(ask('GET', '/auth/users'))).status).toBe(200);
  });
});

describe('L1 — guessing from rotating addresses slows the account down, it does not lock the owner out', () => {
  it('the throttle no longer hard-blocks a login for an address that never failed', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < 50; i += 1) throttle.fail('alice', `10.0.0.${i}`);
    expect(throttle.blocked('alice', '192.168.1.1')).toBe(false);
    // …but every further try on that login is slowed down
    expect(throttle.slowdownMs('alice')).toBeGreaterThan(0);
    expect(throttle.slowdownMs('bob')).toBe(0);
    now = 16 * 60 * 1000;
    expect(throttle.slowdownMs('alice')).toBe(0);
  });

  it('the real admin from a new address logs in after an address-rotating attack', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({ login: 'alice', displayName: 'A', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    // 1 ms slow-down so the test does not wait seconds
    const throttle = new LoginThrottle(() => Date.now(), 5, 5 * 60_000, 50, 15 * 60_000, 1);
    const api = createApi(store, { loginThrottle: throttle }) as (r: ApiRequest) => Promise<Reply>;
    for (let i = 0; i < 50; i += 1) throttle.fail('alice', `198.51.100.${i}`);
    const reply = await api(ask('POST', '/auth/login', {
      body: { login: 'alice', password: PASSWORD },
      headers: { 'x-forwarded-for': '203.0.113.200' },
    }));
    expect(reply.status).toBe(200);
  });
});

describe('L2 / L11 — the CSRF origin backstop', () => {
  const write = (headers: Record<string, string>): ApiRequest =>
    ({ method: 'PATCH', path: '/auth/me', query: {}, headers: { host: 'studio.local', ...headers } }) as ApiRequest;

  it('rejects Origin: null on a cookie write', () => {
    expect(crossSiteWrite(write({ origin: 'null' }), [])?.status).toBe(403);
  });

  it('rejects a missing Origin when the browser says the request came from elsewhere', () => {
    expect(crossSiteWrite(write({ 'sec-fetch-site': 'cross-site' }), [])?.status).toBe(403);
    expect(crossSiteWrite(write({ 'sec-fetch-site': 'same-site' }), [])?.status).toBe(403);
    expect(crossSiteWrite(write({ 'sec-fetch-site': 'same-origin' }), [])).toBeUndefined();
    // Neither header — a non-browser client, which cannot carry a victim's cookie
    expect(crossSiteWrite(write({}), [])).toBeUndefined();
  });

  it('still lets the app itself through (same host, or the configured dev origin)', () => {
    expect(crossSiteWrite(write({ origin: 'http://studio.local' }), [])).toBeUndefined();
    expect(crossSiteWrite(write({ origin: 'http://localhost:5173' }), ['http://localhost:5173'])).toBeUndefined();
  });

  it("CORS_ORIGIN='*' does not make every site's cookie write acceptable", () => {
    expect(crossSiteWrite(write({ origin: 'https://evil.example' }), ['*'])?.status).toBe(403);
  });

  it('end to end: a logged-in cookie write with Origin: null is refused, an API key is unaffected', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({ login: 'alice', displayName: 'A', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store, { auth: { tokens: ['full-key'], readOnlyTokens: [] } }) as (r: ApiRequest) => Promise<Reply>;
    const login = await api(ask('POST', '/auth/login', { body: { login: 'alice', password: PASSWORD } }));
    const cookie = cookieFrom(login);
    const blocked = await api(ask('PATCH', '/auth/me', { cookie, headers: { origin: 'null', host: 'studio.local' }, body: { displayName: 'X' } }));
    expect(blocked.status).toBe(403);
    // Machines carry no cookie and no Origin — the key is what authenticates them
    const machine = await api(ask('GET', '/packages', { token: 'full-key' }));
    expect(machine.status).toBe(200);
  });
});

describe('L3 — the first admin is created exactly once', () => {
  it('two parallel setups create one admin; the other gets 409', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as (r: ApiRequest) => Promise<Reply>;
    const [a, b] = await Promise.all([
      api(ask('POST', '/auth/setup', { body: { login: 'admin1', password: 'longenough-pw-1', displayName: 'A' } })),
      api(ask('POST', '/auth/setup', { body: { login: 'admin2', password: 'longenough-pw-2', displayName: 'B' } })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await store.listUsers()).filter((u) => u.role === 'admin')).toHaveLength(1);
  });
});

describe('L10 — private workspaces need a way to tell people apart', () => {
  it('an open server (no accounts, no keys) with private workspaces refuses package requests', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { privateWorkspaces: true }) as (r: ApiRequest) => Promise<Reply>;
    const reply = await api(ask('GET', '/packages'));
    expect(reply.status).toBe(403);
    // The way out stays open: creating the first admin
    const setup = await api(ask('POST', '/auth/setup', { body: { login: 'admin', password: 'longenough-pw-1' } }));
    expect(setup.status).toBe(201);
    expect((await api(ask('GET', '/packages', { cookie: cookieFrom(setup) }))).status).toBe(200);
  });
});
