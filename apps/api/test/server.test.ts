/**
 * 전송 계층 연기(smoke) 시험.
 *
 * 판단은 api.test.ts가 다 검증한다. 여기서 볼 것은 하나다 —
 * 진짜 소켓으로 바이트를 넣고 뺐을 때 본문 파싱·응답 쓰기가 어긋나지 않는가.
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

describe('HTTP 서버', () => {
  it('업로드 → 조회 → 내려받기가 소켓 위에서 그대로 돈다', async () => {
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
    // ZIP 매직 넘버 — 진짜 AASX가 나왔는지
    expect([...downloaded.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it('JSON 본문도 그대로 오간다', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(await health.json()).toMatchObject({ status: 'ok', auth: 'off' });
    // 판 번호가 함께 온다 — 배포처가 여럿이면 문의의 첫 질문이다
    expect((await (await fetch(`${baseUrl}/health`)).json()).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('업로드 상한을 넘기면 거절한다 (Zip Bomb 대비)', async () => {
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
