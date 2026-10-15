/**
 * Transport-layer limits from the 2026-10-16 red-team review — they only exist on a real socket.
 *
 *   L5 — a request that fails before reaching the API (body over the cap, broken JSON) still gets the security headers
 *   L9 — big uploads are held in memory whole, so only a couple run at once, and the body cap follows the AASX cap
 */
import { bodyLimitFor, createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(options: Parameters<typeof createHttpServer>[0]): Promise<string> {
  const server = createHttpServer({ store: new InMemoryStore(), ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('L5 — error responses written by the transport carry the security headers', () => {
  it('413 for a body over the cap', async () => {
    const base = await listen({ maxBodyBytes: 10 });
    const response = await fetch(`${base}/packages?name=big.aasx`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(100),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('400 for a JSON body that does not parse', async () => {
    const base = await listen({});
    const response = await fetch(`${base}/packages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('L9 — upload memory', () => {
  it('the body cap follows AASX_MAX_TOTAL_MB instead of always being 512 MB', () => {
    expect(bodyLimitFor({}, undefined)).toBe(512 * 1024 * 1024);
    expect(bodyLimitFor({}, { maxTotalUncompressedBytes: 64 * 1024 * 1024 })).toBe(128 * 1024 * 1024);
    // Never above the default, and an explicit maxBodyBytes still wins
    expect(bodyLimitFor({}, { maxTotalUncompressedBytes: 4096 * 1024 * 1024 })).toBe(512 * 1024 * 1024);
    expect(bodyLimitFor({ maxBodyBytes: 10 }, { maxTotalUncompressedBytes: 64 * 1024 * 1024 })).toBe(10);
  });

  it('a large upload past the concurrency cap gets 503 with Retry-After; small requests are unaffected', async () => {
    const base = await listen({ largeUploads: { thresholdBytes: 1024, maxConcurrent: 1 } });
    const { port } = new URL(base);

    // First large upload: announce 4 KB, send 2 KB, keep the connection open
    const first: ClientRequest = httpRequest({
      host: '127.0.0.1',
      port: Number(port),
      method: 'POST',
      path: '/packages?name=a.aasx',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4096' },
    });
    first.on('error', () => undefined);
    first.write(new Uint8Array(2048));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await fetch(`${base}/packages?name=b.aasx`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(4096),
    });
    expect(second.status).toBe(503);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);

    // Small requests do not queue behind big ones
    expect((await fetch(`${base}/health`)).status).toBe(200);
    first.destroy();
  });
});
