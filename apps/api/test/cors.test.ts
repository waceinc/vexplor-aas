/**
 * CORS — no headers by default (the browser blocks). Only origins listed in CORS_ORIGIN pass.
 * Preflight requests (OPTIONS) are answered before auth — because the token is only sent with the actual request.
 */
import { createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { corsFromEnv, corsHeaders } from '../src/cors.js';

async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: ReturnType<typeof createHttpServer>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('parsing CORS_ORIGIN', () => {
  it('empty allows no origin', () => {
    expect(corsFromEnv({}).origins).toEqual([]);
    expect(corsFromEnv({ CORS_ORIGIN: '  ' }).origins).toEqual([]);
    expect(corsHeaders(corsFromEnv({}), 'http://a.example')).toEqual({});
  });

  it('comma list — trims spaces and trailing slashes and compares case-insensitively', () => {
    const policy = corsFromEnv({ CORS_ORIGIN: ' http://mes.local:3000/, https://Portal.Example ' });
    expect(policy.origins).toEqual(['http://mes.local:3000', 'https://Portal.Example']);
    expect(corsHeaders(policy, 'http://mes.local:3000')['access-control-allow-origin']).toBe('http://mes.local:3000');
    expect(corsHeaders(policy, 'https://portal.example/')['access-control-allow-origin']).toBe('https://portal.example/');
    expect(corsHeaders(policy, 'http://evil.example')).toEqual({});
    expect(corsHeaders(policy, undefined)).toEqual({});
    expect(corsHeaders(policy, 'http://mes.local:3000').vary).toBe('Origin');
  });

  it('* means all — and is written as * in the response too', () => {
    const policy = corsFromEnv({ CORS_ORIGIN: '*' });
    expect(corsHeaders(policy, 'http://anything')['access-control-allow-origin']).toBe('*');
  });
});

describe('CORS over HTTP', () => {
  it('default — no CORS headers even with an Origin, and preflight is 403', async () => {
    const server = createHttpServer({ store: new InMemoryStore(), cors: { origins: [] } });
    const base = await listen(server);
    try {
      const plain = await fetch(`${base}/health`, { headers: { origin: 'http://a.example' } });
      expect(plain.status).toBe(200);
      expect(plain.headers.get('access-control-allow-origin')).toBeNull();

      const preflight = await fetch(`${base}/packages`, {
        method: 'OPTIONS',
        headers: { origin: 'http://a.example', 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(403);
    } finally {
      await close(server);
    }
  });

  it('allowed origin — preflight is 204 before auth, the actual response gets headers and exposes ETag', async () => {
    const server = createHttpServer({
      store: new InMemoryStore(),
      cors: { origins: ['http://mes.local'] },
      auth: { tokens: ['secret'], readOnlyTokens: [] },
    });
    const base = await listen(server);
    try {
      // OPTIONS without a token — it must be 204, not 401, for the browser to send the actual request
      const preflight = await fetch(`${base}/packages`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://mes.local',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://mes.local');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');

      // Actual request — auth still works (401 without a token), headers are attached
      const denied = await fetch(`${base}/packages`, { headers: { origin: 'http://mes.local' } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get('access-control-allow-origin')).toBe('http://mes.local');

      const ok = await fetch(`${base}/packages`, {
        headers: { origin: 'http://mes.local', authorization: 'Bearer secret' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-expose-headers')).toContain('etag');

      // A disallowed origin gets no headers (the browser blocks) — the server response itself is normal
      const other = await fetch(`${base}/packages`, {
        headers: { origin: 'http://other.local', authorization: 'Bearer secret' },
      });
      expect(other.status).toBe(200);
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close(server);
    }
  });
});
