/**
 * 저작 UI를 API와 같은 포트에서 내주는 부분.
 *
 * 여기서 지키는 것은 셋이다.
 *  ① 뿌리 밖으로 나가지 않는다 (Zip Slip과 같은 종류의 문제 — 기획서 Ⅷ)
 *  ② API 경로를 가로채지 않는다
 *  ③ 정적 파일에는 토큰을 요구하지 않는다 — 화면이 떠야 토큰을 넣을 수 있다
 */
import { createHttpServer, resolveStatic } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'aas-web-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>AAS</title>');
writeFileSync(join(root, 'assets', 'main-abc123.js'), 'console.log(1)');
writeFileSync(join(root, 'secret.env'), 'AAS_TOKEN=비밀');

describe('경로 옮기기', () => {
  it('/ 는 index.html', async () => {
    expect((await resolveStatic(root, '/'))?.contentType).toBe('text/html; charset=utf-8');
  });

  it('🔴 뿌리 밖은 내주지 않는다', async () => {
    expect(await resolveStatic(root, '/../../etc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/..%2f..%2fetc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/index.html%00.png')).toBeUndefined();
    expect(await resolveStatic(root, '/%ZZ')).toBeUndefined(); // 깨진 인코딩
  });

  it('🔴 모르는 확장자는 내주지 않는다 — 추측해서 내보내지 않는다', async () => {
    expect(await resolveStatic(root, '/secret.env')).toBeUndefined();
  });

  it('해시가 박힌 파일만 오래 캐시한다', async () => {
    expect((await resolveStatic(root, '/assets/main-abc123.js'))?.cacheControl).toContain('immutable');
    // index.html을 캐시하면 새 판을 올려도 옛 화면이 남는다
    expect((await resolveStatic(root, '/index.html'))?.cacheControl).toBe('no-cache');
  });
});

describe('서버에 붙였을 때', () => {
  const server = createHttpServer({
    store: new InMemoryStore(),
    webRoot: root,
    auth: { tokens: ['t'], readOnlyTokens: [] },
  });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('🔴 화면은 토큰 없이 뜬다 — 그래야 토큰을 넣을 수 있다', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>AAS</title>');
  });

  it('🔴 보안 머리글이 정적 파일에도 붙는다 — CSP가 지키는 것이 바로 이 화면이다', async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    // API 응답에도
    const api = await fetch(`${base}/health`);
    expect(api.headers.get('content-security-policy')).toContain("script-src 'self'");
    // 평문으로 받았으니 HSTS는 없다
    expect(page.headers.get('strict-transport-security')).toBeNull();
  });

  it('🔴 API 경로는 가로채지 않는다', async () => {
    // 인증이 켜져 있으므로 401이어야 한다. 200 + HTML이 오면 정적이 가로챈 것이다
    const response = await fetch(`${base}/packages`);
    expect(response.status).toBe(401);
  });

  it('없는 경로로 새로고침해도 앱 껍데기를 준다', async () => {
    const response = await fetch(`${base}/어딘가`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>AAS</title>');
  });

  it('JSON을 달라고 하면 껍데기를 주지 않는다 — 없는 API를 200으로 속이지 않는다', async () => {
    // 인증이 켜져 있으면 경로 대조보다 인가가 먼저라 401이다(어떤 경로가 있는지 알려 주지 않는다)
    const response = await fetch(`${base}/api/없는것`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('json');
  });
});

describe('인증을 끈 배포에서', () => {
  const server = createHttpServer({ store: new InMemoryStore(), webRoot: root });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('없는 API는 404 JSON 그대로', async () => {
    const response = await fetch(`${base}/없는것`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('json');
  });

  it('화면 요청은 껍데기', async () => {
    const response = await fetch(`${base}/없는것`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
  });
});
