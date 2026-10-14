/**
 * Serving the authoring UI on the same port as the API.
 *
 * Three things guarded here.
 *  1. Never step outside the root (the same class of problem as Zip Slip — plan section VIII)
 *  2. Never intercept API paths
 *  3. Static files require no token — the UI must load before a token can be entered
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

describe('path resolution', () => {
  it('/ is index.html', async () => {
    expect((await resolveStatic(root, '/'))?.contentType).toBe('text/html; charset=utf-8');
  });

  it('Important: does not serve outside the root', async () => {
    expect(await resolveStatic(root, '/../../etc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/..%2f..%2fetc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(await resolveStatic(root, '/index.html%00.png')).toBeUndefined();
    expect(await resolveStatic(root, '/%ZZ')).toBeUndefined(); // broken encoding
  });

  it('Important: does not serve unknown extensions — never guesses', async () => {
    expect(await resolveStatic(root, '/secret.env')).toBeUndefined();
  });

  it('caches long only files with a hash in the name', async () => {
    expect((await resolveStatic(root, '/assets/main-abc123.js'))?.cacheControl).toContain('immutable');
    // Caching index.html would keep the old UI after a new version is deployed
    expect((await resolveStatic(root, '/index.html'))?.cacheControl).toBe('no-cache');
  });
});

describe('when attached to the server', () => {
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

  it('Important: the UI loads without a token — so the token can be entered', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>AAS</title>');
  });

  it('Important: security headers apply to static files too — this UI is exactly what CSP protects', async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    // On API responses too
    const api = await fetch(`${base}/health`);
    expect(api.headers.get('content-security-policy')).toContain("script-src 'self'");
    // Received over plain HTTP, so no HSTS
    expect(page.headers.get('strict-transport-security')).toBeNull();
  });

  it('Important: does not intercept API paths', async () => {
    // Auth is on, so this must be 401. A 200 with HTML means static serving intercepted it
    const response = await fetch(`${base}/packages`);
    expect(response.status).toBe(401);
  });

  it('serves the app shell when reloading on an unknown path', async () => {
    const response = await fetch(`${base}/어딘가`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>AAS</title>');
  });

  it('does not serve the shell when JSON is requested — does not fake a missing API as 200', async () => {
    // With auth on, authorization comes before route matching, so it is 401 (does not reveal which routes exist)
    const response = await fetch(`${base}/api/없는것`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('json');
  });
});

describe('on a deployment with auth off', () => {
  const server = createHttpServer({ store: new InMemoryStore(), webRoot: root });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('an unknown API stays a 404 JSON', async () => {
    const response = await fetch(`${base}/없는것`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('json');
  });

  it('a page request gets the shell', async () => {
    const response = await fetch(`${base}/없는것`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
  });
});
