/**
 * CORS — 기본은 헤더 없음(브라우저가 막는다). CORS_ORIGIN에 적은 출처만 통과한다.
 * 사전 요청(OPTIONS)은 인증보다 먼저 답한다 — 토큰은 본 요청에만 실리기 때문이다.
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

describe('CORS_ORIGIN 해석', () => {
  it('비어 있으면 아무 출처도 허용하지 않는다', () => {
    expect(corsFromEnv({}).origins).toEqual([]);
    expect(corsFromEnv({ CORS_ORIGIN: '  ' }).origins).toEqual([]);
    expect(corsHeaders(corsFromEnv({}), 'http://a.example')).toEqual({});
  });

  it('쉼표 목록 — 공백·끝 슬래시를 정리하고 대소문자를 무시해 견준다', () => {
    const policy = corsFromEnv({ CORS_ORIGIN: ' http://mes.local:3000/, https://Portal.Example ' });
    expect(policy.origins).toEqual(['http://mes.local:3000', 'https://Portal.Example']);
    expect(corsHeaders(policy, 'http://mes.local:3000')['access-control-allow-origin']).toBe('http://mes.local:3000');
    expect(corsHeaders(policy, 'https://portal.example/')['access-control-allow-origin']).toBe('https://portal.example/');
    expect(corsHeaders(policy, 'http://evil.example')).toEqual({});
    expect(corsHeaders(policy, undefined)).toEqual({});
    expect(corsHeaders(policy, 'http://mes.local:3000').vary).toBe('Origin');
  });

  it('*는 전부 — 응답에도 *로 적는다', () => {
    const policy = corsFromEnv({ CORS_ORIGIN: '*' });
    expect(corsHeaders(policy, 'http://anything')['access-control-allow-origin']).toBe('*');
  });
});

describe('CORS over HTTP', () => {
  it('기본 — Origin이 와도 CORS 헤더가 없고, 사전 요청은 403', async () => {
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

  it('허용 출처 — 사전 요청은 인증 전에 204, 본 응답에는 헤더가 붙고 ETag를 내보낸다', async () => {
    const server = createHttpServer({
      store: new InMemoryStore(),
      cors: { origins: ['http://mes.local'] },
      auth: { tokens: ['secret'], readOnlyTokens: [] },
    });
    const base = await listen(server);
    try {
      // 토큰 없이 OPTIONS — 401이 아니라 204여야 브라우저가 본 요청을 보낸다
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

      // 본 요청 — 인증은 그대로 작동한다(토큰 없으면 401), 헤더는 붙는다
      const denied = await fetch(`${base}/packages`, { headers: { origin: 'http://mes.local' } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get('access-control-allow-origin')).toBe('http://mes.local');

      const ok = await fetch(`${base}/packages`, {
        headers: { origin: 'http://mes.local', authorization: 'Bearer secret' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-expose-headers')).toContain('etag');

      // 허용되지 않은 출처는 헤더 없음(브라우저가 막는다) — 서버 응답 자체는 정상
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
