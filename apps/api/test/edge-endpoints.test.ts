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
import { aidReadList } from '../src/integration/bundle-build.js';
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
      rawTarget: url.pathname + url.search,
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
  it('aidReadList (@aas/bundle) gives another product the very read list the server hands the edge', async () => {
    const { packageId, admin, code, edge } = await setup();
    const { deviceId } = await edge.register(code);
    await approve(admin, deviceId);
    const list = await edge.readList();
    expect(list.state).toBe('approved');
    expect(list.interfaces).toHaveLength(1);
    expect(list.interfaces).toEqual(aidReadList(withAid().environment, packageId, 1000));
    // Another file id gives other tag ids — they are stable per package, not per address
    expect(aidReadList(withAid().environment, 'pkg_other', 1000)[0]!.tags[0]!.tagId).not.toBe(list.interfaces[0]!.tags[0]!.tagId);
  });

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

  it('a batch stored but not recorded as seen (crash in between) is not stored twice when sent again', async () => {
    const { store, packageId, admin, code, edge, dir } = await setup();
    const { deviceId } = await edge.register(code);
    await approve(admin, deviceId);
    const list = await edge.readList();
    const batch = edge.enqueue(list);
    expect(await edge.flush()).toBe('ok');
    // Forget that the batch was seen — what a crash between storing and recording leaves behind
    await store.putRuntimeState(`edge.seen.${deviceId}`, []);
    writeFileSync(join(dir, 'queue', `${edge.bootId}-${String(batch.seq).padStart(8, '0')}.json`), JSON.stringify(batch));
    expect(await edge.flush()).toBe('ok');
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

describe('edge hardening (review of PR #19)', () => {
  it('H1 — shared (ownerless) files are not listed, and a file deleted after approval is refused per sample, never half-stored', async () => {
    const base = new InMemoryStore();
    const mine = await base.importPackage({ name: 'mine.aasx', package: withAid('Mine'), owner: 'user:a' });
    const gone = await base.importPackage({ name: 'gone.aasx', package: withAid('Gone'), owner: 'user:a' });
    await base.importPackage({ name: 'shared.aasx', package: withAid('Shared') });
    const store = scopeStore(base);
    const registry = new EdgeRegistry(base);
    const routes = edgeAdminRoutes({ registry, store, intervalMs: 1000, partitioned: true });
    const route = (pattern: string) => routes.find((r) => r.pattern === pattern)!;
    const handle = createEdgeHandler({ registry, store, serverVersion: 'test', partitioned: true });
    const { code } = await registry.createCode('user:a');
    const edge = createMockEdge({ server: 'http://edge.test', stateDir: stateDir(), fetchImpl: viaApi(handle) });
    const { deviceId } = await edge.register(code);
    await runInWorkspace({ key: 'user:a', seesAll: false }, async () => {
      const preview = (await route('/edge/devices/:deviceId/read-list-preview').handle({ request: {} as ApiRequest, params: { deviceId } })).body as {
        revision: string;
        interfaces: { packageId: string }[];
      };
      expect(preview.interfaces.map((i) => i.packageId).sort()).toEqual([gone.id, mine.id].sort());
      await route('/edge/devices/:deviceId/approve').handle({ request: { body: { revision: preview.revision } } as ApiRequest, params: { deviceId } });
    });
    const list = await edge.readList();
    await base.deletePackage(gone.id);
    edge.enqueue(list);
    expect(await edge.flush()).toBe('ok');
    expect(edge.stats).toMatchObject({ accepted: 2, rejected: 2 });
    expect(await base.readValues(mine.id)).toHaveLength(2);
  });

  it('H2 — idempotency memory stays bounded and handles seqs out of order', async () => {
    const base = new InMemoryStore();
    const registry = new EdgeRegistry(base);
    let writes = 0;
    const store = async () => {
      writes += 1;
    };
    const boot = '7f1d2c3e-0a4b-4c5d-8e6f-112233445566';
    expect(await registry.once('dev_x', boot, 2, store)).toBe(true);
    expect(await registry.once('dev_x', boot, 1, store)).toBe(true);
    expect(await registry.once('dev_x', boot, 2, store)).toBe(false);
    expect(await registry.once('dev_x', boot, 1, store)).toBe(false);
    for (let i = 0; i < 12; i += 1) await registry.once('dev_x', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 1, store);
    const kept = (await base.getRuntimeState('edge.seen.dev_x')) as { bootId: string; floor: number; above: number[] }[];
    expect(kept).toHaveLength(8);
    expect(kept.every((boot) => boot.above.length === 0)).toBe(true);
    expect(writes).toBe(14);
  });

  it('H2 — a boot id that is not a UUID is refused, and the edge moves the batch to refused/', async () => {
    const { store, packageId, admin, code, edge, dir } = await setup();
    await approve(admin, (await edge.register(code)).deviceId);
    const list = await edge.readList();
    const batch = edge.enqueue(list);
    writeFileSync(join(dir, 'queue', `${edge.bootId}-${String(batch.seq).padStart(8, '0')}.json`), JSON.stringify({ ...batch, bootId: 'x'.repeat(10_000) }));
    expect(await edge.flush()).toBe('ok');
    expect(readdirSync(join(dir, 'refused'))).toHaveLength(1);
    expect(edge.stats.sent).toBe(0);
    expect(await store.readValues(packageId)).toHaveLength(0);
  });

  it('H3 — registration is limited per address before its signature is checked', async () => {
    const { handle } = await setup();
    const attempt = () =>
      handle({
        method: 'POST',
        path: '/edge/v1/register',
        query: {},
        queryAll: {},
        remoteAddress: '203.0.113.9',
        headers: { 'content-type': 'application/json' },
        body: { schema: 'vexplor.edge.register/1', code: 'NOPE-NOPE-NOPE', publicKey: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', device: { name: 'x', software: { name: 'x', version: '1' } } },
      });
    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('M4 — on a partitioned server a device without a workspace is refused', async () => {
    const base = new InMemoryStore();
    const registry = new EdgeRegistry(base);
    const { code } = await registry.createCode(null);
    const handle = createEdgeHandler({ registry, store: scopeStore(base), serverVersion: 'test', partitioned: true });
    const edge = createMockEdge({ server: 'http://edge.test', stateDir: stateDir(), fetchImpl: viaApi(handle) });
    await edge.register(code);
    await expect(edge.readList()).rejects.toMatchObject({ answer: { status: 403, body: { code: 'DeviceRevoked' } } });
  });

  it('L — a sample whose value does not fit the tag type is refused, the rest stored', async () => {
    const { store, packageId, admin, code, edge } = await setup();
    await approve(admin, (await edge.register(code)).deviceId);
    const list = await edge.readList();
    const speed = list.interfaces[0]!.tags.find((tag) => tag.type === 'float')!;
    edge.enqueue(list, [{ tagId: speed.tagId, observedAt: '2026-10-16T00:00:00.000Z', receivedAt: '2026-10-16T00:00:00.000Z', value: 'fast' }]);
    expect(await edge.flush()).toBe('ok');
    expect(edge.stats).toMatchObject({ accepted: 2, rejected: 1 });
    expect(await store.readValues(packageId)).toHaveLength(2);
  });
});

describe('edge read intervals per interface and tag (plan gap 6)', () => {
  it('approval sets intervals; a re-approval with other intervals changes the revision the edge sees', async () => {
    const { admin, code, edge } = await setup();
    const { deviceId } = await edge.register(code);
    const preview = (await admin('GET', `/edge/devices/${deviceId}/read-list-preview`)).body as {
      revision: string;
      interfaces: { interfaceId: string; tags: { tagId: string }[] }[];
    };
    const iface = preview.interfaces[0]!;
    const fast = iface.tags[0]!.tagId;
    const approved = await admin('POST', `/edge/devices/${deviceId}/approve`, {
      revision: preview.revision,
      intervals: { [iface.interfaceId]: 5000, [fast]: 200 },
    });
    expect(approved.status).toBe(200);
    const first = await edge.readList();
    expect(first.interfaces[0]!.intervalMs).toBe(5000);
    expect((first.interfaces[0]!.tags[0] as { intervalMs?: number }).intervalMs).toBe(200);
    expect((first.interfaces[0]!.tags[1] as { intervalMs?: number }).intervalMs).toBeUndefined();

    // Same files, new interval: the edge must not get 304 for its cached list
    await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [iface.interfaceId]: 1000 } });
    const second = await edge.readList();
    expect(second.revision).not.toBe(first.revision);
    expect(second.interfaces[0]!.intervalMs).toBe(1000);
    // Files unchanged — not reported as changed since approval
    const devices = (await admin('GET', '/edge/devices')).body as { items: { changedSinceApproval: boolean }[] };
    expect(devices.items[0]!.changedSinceApproval).toBe(false);
  });

  it('refuses intervals outside 100 ms – 1 h and ids not in the list', async () => {
    const { admin, code, edge } = await setup();
    const { deviceId } = await edge.register(code);
    const preview = (await admin('GET', `/edge/devices/${deviceId}/read-list-preview`)).body as { revision: string; interfaces: { interfaceId: string }[] };
    const id = preview.interfaces[0]!.interfaceId;
    expect((await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [id]: 50 } })).status).toBe(400);
    expect((await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { [id]: 3_600_001 } })).status).toBe(400);
    expect((await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision, intervals: { nope: 1000 } })).status).toBe(400);
  });
});
