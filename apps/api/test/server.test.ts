/**
 * Transport layer smoke test.
 *
 * The logic is fully verified by api.test.ts. Only one thing matters here —
 * whether body parsing and response writing stay correct when bytes go in and out over a real socket.
 */
import { createHttpServer } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const goldenBytes = readFileSync(root + '01-롤포밍기-공34.aasx');

let baseUrl: string;
let server: ReturnType<typeof createHttpServer>;

beforeAll(async () => {
  server = createHttpServer({ store: new InMemoryStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('HTTP server', () => {
  it('upload -> query -> download works as is over a socket', async () => {
    const upload = await fetch(`${baseUrl}/packages?name=${encodeURIComponent('01-롤포밍기-공34.aasx')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: goldenBytes,
    });
    expect(upload.status).toBe(201);
    const record = (await upload.json()) as { packageId: string };

    const lint = await fetch(`${baseUrl}/packages/${record.packageId}/lint`);
    expect(lint.status).toBe(200);
    expect(((await lint.json()) as { passed: boolean }).passed).toBe(true);

    const download = await fetch(`${baseUrl}/packages/${record.packageId}`);
    expect(download.status).toBe(200);
    const downloaded = new Uint8Array(await download.arrayBuffer());
    // ZIP magic number — whether a real AASX came out
    expect([...downloaded.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it('JSON bodies round-trip as is too', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(await health.json()).toMatchObject({ status: 'ok', auth: 'off' });
    // The version number comes along — with several deployments it is the first question in any inquiry
    expect((await (await fetch(`${baseUrl}/health`)).json()).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects uploads over the limit (Zip Bomb protection)', async () => {
    const small = createHttpServer({ store: new InMemoryStore(), maxBodyBytes: 10 });
    await new Promise<void>((resolve) => small.listen(0, '127.0.0.1', resolve));
    const port = (small.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/packages?name=big.aasx`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: goldenBytes,
    });
    expect(response.status).toBe(413);
    expect(JSON.stringify(await response.json())).toContain('상한');
    await new Promise<void>((resolve) => small.close(() => resolve()));
  });
});
