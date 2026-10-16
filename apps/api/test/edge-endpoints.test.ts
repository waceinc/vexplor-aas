/**
 * The edge endpoints (docs/edge-contract.md) driven by the mock edge (scripts/mock-edge.mjs) — the same client the
 * VEXPLOR Logic Studio server side is tested with. The first test goes over real HTTP; the rest call the API function.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore, runInWorkspace, scopeStore } from '@aas/store';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, createHttpServer, type ApiRequest, type ApiResponse } from '@aas/api';
import { createEdgeHandler } from '../src/edge/routes-edge.js';
import { edgeAdminRoutes } from '../src/edge/routes-edge-admin.js';
import { EdgeRegistry } from '../src/edge/state.js';
import { createMockEdge } from '../../../scripts/mock-edge.mjs';

const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
const stateDir = (): string => mkdtempSync(join(tmpdir(), 'edge-'));

/** The roll forming machine with an AID of two OPC UA tags */
function withAid(assetName = 'RollFormingMachine') {
  const pkg = readAasx(golden);
  pkg.environment.submodels!.push(
    buildAidSubmodel({
      assetName,
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: 'opc.tcp://192.168.10.21:4840',
      tags: [
        { name: 'SpindleSpeed', href: 'ns=2;s=Machine.SpindleSpeed', type: 'float' },
        { name: 'Running', href: 'ns=2;s=Machine.Running', type: 'boolean' },
      ],
    }) as never,
  );
  return pkg;
}

/** fetch for the mock edge that calls the API function — body bytes passed as rawBody, as server.ts does */
function viaApi(handle: (request: ApiRequest) => Promise<ApiResponse>) {
  return async (url: URL, init: RequestInit): Promise<Response> => {
    const text = typeof init.body === 'string' ? init.body : undefined;
    const response = await handle({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      queryAll: {},
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      ...(text !== undefined ? { body: JSON.parse(text) as unknown, rawBody: new TextEncoder().encode(text) } : {}),
    });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status, headers: response.headers });
  };
}

async function setup(limits?: { requestsPerMinute?: number }) {
  const store = new InMemoryStore();
  const record = await store.importPackage({ name: 'line1.aasx', package: withAid() });
  const handle = createApi(store, { edge: { intervalMs: 1000, ...(limits ? { limits } : {}) } });
  const admin = async (method: string, path: string, body?: unknown) =>
    handle({ method, path, query: {}, queryAll: {}, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  const code = ((await admin('POST', '/edge/registration-codes')).body as { code: string }).code;
  const dir = stateDir();
  const edge = createMockEdge({ server: 'http://edge.test', stateDir: dir, fetchImpl: viaApi(handle), sleep: async () => undefined });
  return { store, packageId: record.id, handle, admin, code, edge, dir };
}

async function approve(admin: Awaited<ReturnType<typeof setup>>['admin'], deviceId: string) {
  const preview = (await admin('GET', `/edge/devices/${deviceId}/read-list-preview`)).body as { revision: string };
  return admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision });
}

const saved = process.env['EDGE'];
afterEach(() => {
  if (saved === undefined) delete process.env['EDGE'];
  else process.env['EDGE'] = saved;
});

describe('edge endpoints with the mock edge', () => {
  it('over real HTTP: register, wait for approval, send batches, values stored once', async () => {
    process.env['EDGE'] = 'on';
    const store = new InMemoryStore();
    const record = await store.importPackage({ name: 'line1.aasx', package: withAid() });
    const server = createHttpServer({ store });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const code = ((await (await fetch(`${base}/edge/registration-codes`, { method: 'POST' })).json()) as { code: string }).code;
      const edge = createMockEdge({ server: base, stateDir: stateDir(), sleep: async () => undefined });
      const { deviceId } = await edge.register(code);
      expect((await edge.readList()).state).toBe('pending-approval');

      const preview = (await (await fetch(`${base}/edge/devices/${deviceId}/read-list-preview`)).json()) as { revision: string };
      const approved = await fetch(`${base}/edge/devices/${deviceId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: preview.revision }),
      });
      expect(approved.status).toBe(200);
      const list = await edge.readList();
      expect(list.state).toBe('approved');
      expect(list.interfaces[0]!.tags.map((tag) => tag.tagId)).toHaveLength(2);

      for (let i = 0; i < 3; i += 1) edge.enqueue(list);
      expect(await edge.flush()).toBe('ok');
      expect(edge.stats).toMatchObject({ sent: 3, accepted: 6, duplicates: 0, rejected: 0 });
      expect(await store.readValues(record.id)).toHaveLength(6);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a batch sent again is stored once (lost answer, same bootId and seq)', async () => {
    const { store, packageId, admin, code, edge, dir } = await setup();
    await approve(admin, (await edge.register(code)).deviceId);
    const list = await edge.readList();
    const batch = edge.enqueue(list);
    expect(await edge.flush()).toBe('ok');
    expect(await store.readValues(packageId)).toHaveLength(2);
    // The edge never saw the answer — the same batch goes back into the queue and is sent again
    writeFileSync(join(dir, 'queue', `${edge.bootId}-${String(batch.seq).padStart(8, '0')}.json`), JSON.stringify(batch));
    expect(await edge.flush()).toBe('ok');
    expect(edge.stats).toMatchObject({ sent: 2, accepted: 2, duplicates: 1 });
    expect(readdirSync(join(dir, 'queue'))).toEqual([]);
    expect(await store.readValues(packageId)).toHaveLength(2);
  });

  it('stores nothing before approval, and only approved tags after', async () => {
    const { store, packageId, admin, code, edge } = await setup();
    const { deviceId } = await edge.register(code);
    const pending = await edge.readList();
    expect(pending.interfaces).toEqual([]);
    edge.enqueue(pending, [{ tagId: 'tag_made_up', observedAt: '2026-10-16T00:00:00.000Z', receivedAt: '2026-10-16T00:00:00.000Z', value: 1 }]);
    expect(await edge.flush()).toBe('ok');
    expect(edge.stats.rejected).toBe(1);
    expect(await store.readValues(packageId)).toHaveLength(0);

    await approve(admin, deviceId);
    const list = await edge.readList();
    edge.enqueue(list, [{ tagId: 'tag_made_up', observedAt: '2026-10-16T00:00:00.000Z', receivedAt: '2026-10-16T00:00:00.000Z', value: 1 }]);
    await edge.flush();
    expect(edge.stats.rejected).toBe(2);
    expect(await store.readValues(packageId)).toHaveLength(2);
  });

  it('refuses an approval for a list the person did not see, and answers 304 for an unchanged list', async () => {
    const { admin, code, edge } = await setup();
    const { deviceId } = await edge.register(code);
    expect((await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: 'stale' })).status).toBe(409);
    await approve(admin, deviceId);
    const first = await edge.readList();
    const second = await edge.readList(); // sends If-None-Match; the mock returns its cached list on 304
    expect(second).toBe(first);
  });

  it('refuses a used code, a wrong signature, a revoked device and too many requests', async () => {
    const { admin, code, edge, handle } = await setup({ requestsPerMinute: 3 });
    const { deviceId } = await edge.register(code);
    const second = createMockEdge({ server: 'http://edge.test', stateDir: stateDir(), fetchImpl: viaApi(handle) });
    await expect(second.register(code)).rejects.toMatchObject({ answer: { status: 401, body: { code: 'RegistrationCodeInvalid' } } });

    const forged = await handle({
      method: 'GET',
      path: '/edge/v1/read-list',
      query: {},
      queryAll: {},
      headers: { 'x-edge-device': deviceId, 'x-edge-timestamp': String(Math.floor(Date.now() / 1000)), 'x-edge-nonce': 'AAAAAAAAAAAAAAAAAAAAAA', 'x-edge-signature': `ed25519=${Buffer.alloc(64).toString('base64url')}` },
    });
    expect(forged.status).toBe(401);
    expect((forged.body as { code: string }).code).toBe('SignatureInvalid');

    // Three requests a minute pass, the fourth is refused
    for (let i = 0; i < 3; i += 1) await edge.readList();
    await expect(edge.readList()).rejects.toMatchObject({ answer: { status: 429, body: { code: 'RateLimited' } } });
  });

  it('a revoked device is refused and keeps its queue', async () => {
    const { admin, code, edge, dir } = await setup();
    const { deviceId } = await edge.register(code);
    await approve(admin, deviceId);
    const list = await edge.readList();
    await admin('POST', `/edge/devices/${deviceId}/revoke`);
    edge.enqueue(list);
    expect(await edge.flush()).toBe('DeviceRevoked');
    expect(readdirSync(join(dir, 'queue'))).toHaveLength(1);
  });
});

describe('edge workspaces', () => {
  it('a device reads only its own workspace, even when an admin approves it', async () => {
    const base = new InMemoryStore();
    const mine = await base.importPackage({ name: 'mine.aasx', package: withAid('Mine'), owner: 'user:a' });
    await base.importPackage({ name: 'theirs.aasx', package: withAid('Theirs'), owner: 'user:b' });
    const store = scopeStore(base);
    const registry = new EdgeRegistry(base);
    const routes = edgeAdminRoutes({ registry, store, intervalMs: 1000 });
    const route = (pattern: string) => routes.find((r) => r.pattern === pattern)!;
    const handle = createEdgeHandler({ registry, store, serverVersion: 'test' });

    const { code } = await runInWorkspace({ key: 'user:a', seesAll: false }, () => registry.createCode('user:a'));
    const edge = createMockEdge({ server: 'http://edge.test', stateDir: stateDir(), fetchImpl: viaApi(handle) });
    const { deviceId } = await edge.register(code);
    // An admin who sees everything approves — the list is still computed in the device's workspace
    await runInWorkspace({ key: 'user:admin', seesAll: true }, async () => {
      const preview = (await route('/edge/devices/:deviceId/read-list-preview').handle({ request: {} as ApiRequest, params: { deviceId } })).body as {
        revision: string;
        interfaces: { packageId: string }[];
      };
      expect(preview.interfaces.map((i) => i.packageId)).toEqual([mine.id]);
      await route('/edge/devices/:deviceId/approve').handle({ request: { body: { revision: preview.revision } } as ApiRequest, params: { deviceId } });
    });
    const list = await edge.readList();
    expect(list.interfaces).toHaveLength(1);
    // The other workspace cannot see or manage the device
    await runInWorkspace({ key: 'user:b', seesAll: false }, async () => {
      expect(((await route('/edge/devices').handle({ request: {} as ApiRequest, params: {} })).body as { items: unknown[] }).items).toEqual([]);
    });
  });
});
