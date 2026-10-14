/**
 * Access control checks.
 *
 * Four things are checked here.
 *  1. Without a token it is open (development, demos) — but that fact is exposed
 *  2. Configuring a token blocks everything
 *  3. A read-only token can only read
 *  4. /health is always open — needing a token just to see whether it is alive would be a problem
 */
import {
  authFromEnv,
  createApi,
  isAsciiToken,
  isOpen,
  OPEN_ACCESS,
  resolveBindHost,
  tokenOf,
  type ApiRequest,
} from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

async function api(auth?: { tokens: string[]; readOnlyTokens: string[] }) {
  const store = new InMemoryStore();
  await store.init();
  const handle = createApi(store, auth ? { auth } : {});
  return async (
    method: string,
    path: string,
    init: { token?: string; body?: unknown; query?: Record<string, string> } = {},
  ) => {
    const response = await handle({
      method,
      path,
      query: init.query ?? {},
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      ...(init.body === undefined ? {} : { body: init.body }),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
}

describe('when auth is off', () => {
  it('everything works without a token — does not break development and demos', async () => {
    const call = await api();
    expect((await call('GET', '/packages')).status).toBe(200);
    expect(
      (await call('POST', '/packages', { body: goldenBytes, query: { name: 'x.aasx' } })).status,
    ).toBe(201);
  });

  it('Important: /health exposes that auth is off — it must not be silently open', async () => {
    const call = await api();
    expect((await call('GET', '/health')).body).toMatchObject({ status: 'ok', auth: 'off' });
  });
});

describe('when auth is on', () => {
  const auth = { tokens: ['secret-full'], readOnlyTokens: ['secret-read'] };

  it('401 without a token', async () => {
    const call = await api(auth);
    const denied = await call('GET', '/packages');
    expect(denied.status).toBe(401);
    expect(denied.body.messages[0].code).toBe('Unauthorized');
  });

  it('a wrong token is also 401 — does not reveal whether it exists', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: '아무거나' })).status).toBe(401);
    // Same response even with a different length
    expect((await call('GET', '/packages', { token: 'x' })).status).toBe(401);
  });

  it('a full token can read and write', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: 'secret-full' })).status).toBe(200);
    const created = await call('POST', '/packages', {
      token: 'secret-full',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    expect(created.status).toBe(201);
  });

  it('a read-only token can only read — reviewers have no reason to get edit rights', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: 'secret-read' })).status).toBe(200);

    const blocked = await call('POST', '/packages', {
      token: 'secret-read',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.messages[0].text).toContain('읽기 전용');
  });

  it('edit paths are blocked too — blocking only the list is pointless', async () => {
    const call = await api(auth);
    const created = await call('POST', '/packages', {
      token: 'secret-full',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    const id = created.body.packageId;

    // Attempt to delete or edit with a read-only token
    expect((await call('DELETE', `/packages/${id}`, { token: 'secret-read' })).status).toBe(403);
    expect((await call('POST', `/packages/${id}/fix`, { token: 'secret-read' })).status).toBe(403);
    // Part 2 path without a token
    expect((await call('GET', `/packages/${id}/api/v3.0/submodels`)).status).toBe(401);
  });

  it('/health is always open', async () => {
    const call = await api(auth);
    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.auth).toBe('on');
  });
});

describe('reading configuration', () => {
  it('accepts several comma-separated values from the environment variable', () => {
    const config = authFromEnv({ AAS_TOKEN: ' a , b ', AAS_READONLY_TOKEN: 'c' });
    expect(config.tokens).toEqual(['a', 'b']);
    expect(config.readOnlyTokens).toEqual(['c']);
    expect(isOpen(config)).toBe(false);
  });

  it('empty means open', () => {
    expect(isOpen(authFromEnv({}))).toBe(true);
    expect(isOpen(authFromEnv({ AAS_TOKEN: '  ,  ' }))).toBe(true);
  });

  it('Important: Korean tokens work too — Node reads headers as latin1', () => {
    // This is how it arrives over the wire: UTF-8 bytes read as latin1
    const onTheWire = Buffer.from('편집용', 'utf8').toString('latin1');
    expect(onTheWire).not.toBe('편집용'); // left as is, it differs from the configured value

    const request = { headers: { authorization: `Bearer ${onTheWire}` } } as ApiRequest;
    expect(tokenOf(request)).toBe('편집용');
  });

  it('detects non-ASCII tokens — warns at startup', () => {
    expect(isAsciiToken('factory-2026-abc')).toBe(true);
    expect(isAsciiToken('편집용')).toBe(false);
  });

  it('reads tokens only from headers — query parameters end up in logs', () => {
    expect(tokenOf({ headers: { authorization: 'Bearer abc' } } as ApiRequest)).toBe('abc');
    expect(tokenOf({ headers: { authorization: 'bearer  abc  ' } } as ApiRequest)).toBe('abc');
    expect(tokenOf({ headers: {} } as ApiRequest)).toBeUndefined();
  });
});

/**
 * Protected mode — a safeguard for people who pull from the public repository and run it as is.
 * A startup log warning does not reach people who never read it. So it does not listen externally at all.
 */
describe('protected mode — without a token it does not listen externally', () => {
  it('without a token it listens on this machine only', () => {
    expect(resolveBindHost({}, OPEN_ACCESS)).toEqual({ host: '127.0.0.1', protected: true });
  });

  it('with a token it listens externally', () => {
    expect(resolveBindHost({}, { tokens: ['abc'], readOnlyTokens: [] })).toEqual({
      host: '0.0.0.0',
      protected: false,
    });
  });

  it('a read-only token alone also listens externally — for showing to reviewers', () => {
    expect(resolveBindHost({}, { tokens: [], readOnlyTokens: ['ro'] }).host).toBe('0.0.0.0');
  });

  it('AAS_ALLOW_OPEN=1 listens externally without a token — only when explicitly chosen', () => {
    expect(resolveBindHost({ AAS_ALLOW_OPEN: '1' }, OPEN_ACCESS).host).toBe('0.0.0.0');
  });

  it('uses AAS_HOST when given explicitly', () => {
    expect(resolveBindHost({ AAS_HOST: '10.0.0.5' }, OPEN_ACCESS).host).toBe('10.0.0.5');
  });
});
