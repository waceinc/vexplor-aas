/**
 * The remote collector's ingest path under load (2.8.1, load test of 2026-10-18): a batch is one write, its idempotency
 * record goes with it, the record is read once per device, a device record is written alone, and the device list reads
 * each file once per request instead of once per device.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryStore, PostgresStore, type SqlClient } from '@aas/store';
import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiRequest, type ApiResponse } from '@aas/api';
import { EdgeRegistry } from '../src/edge/state.js';
import { createMockEdge } from '../../../scripts/mock-edge.mjs';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
const BOOT = '7f1d2c3e-0a4b-4c5d-8e6f-112233445566';

function withAid(assetName: string) {
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

function adminOf(handle: (request: ApiRequest) => Promise<ApiResponse>) {
  return (method: string, path: string, body?: unknown) =>
    handle({ method, path, query: {}, queryAll: {}, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
}

async function connect(handle: (request: ApiRequest) => Promise<ApiResponse>) {
  const admin = adminOf(handle);
  const code = ((await admin('POST', '/edge/registration-codes')).body as { code: string }).code;
  const edge = createMockEdge({ server: 'http://edge.test', stateDir: mkdtempSync(join(tmpdir(), 'edge-')), fetchImpl: viaApi(handle), sleep: async () => undefined });
  const { deviceId } = await edge.register(code);
  const preview = (await admin('GET', `/edge/devices/${deviceId}/read-list-preview`)).body as { revision: string };
  expect((await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision })).status).toBe(200);
  return { edge, deviceId };
}

/** An in-memory store that counts what it is asked */
class CountingStore extends InMemoryStore {
  reads = new Map<string, number>();
  writes: string[] = [];
  environments = 0;
  override getRuntimeState(key: string): Promise<unknown | undefined> {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return super.getRuntimeState(key);
  }
  override putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> {
    this.writes.push(key);
    return super.putRuntimeState(key, value, packageId);
  }
  override getEnvironment(packageId: string) {
    this.environments += 1;
    return super.getEnvironment(packageId);
  }
}

describe('idempotency record of a batch', () => {
  it('is read from the store once per device, not once per batch, and still holds after a restart', async () => {
    const store = new CountingStore();
    const registry = new EdgeRegistry(store);
    for (let seq = 1; seq <= 20; seq += 1) expect(await registry.once('dev_a', BOOT, seq, async () => undefined)).toBe(true);
    expect(store.reads.get('edge.seen.dev_a')).toBe(1);
    expect(await registry.once('dev_a', BOOT, 7, async () => undefined)).toBe(false);
    // A new process over the same store: what was stored is still known
    const restarted = new EdgeRegistry(store);
    expect(await restarted.once('dev_a', BOOT, 20, async () => undefined)).toBe(false);
    expect(await restarted.once('dev_a', BOOT, 21, async () => undefined)).toBe(true);
  });

  it('is handed to the batch so it can be written with the values; a failed batch records nothing', async () => {
    const store = new CountingStore();
    const registry = new EdgeRegistry(store);
    let handed: { key: string; value: unknown } | undefined;
    expect(
      await registry.once('dev_b', BOOT, 1, async (record) => {
        handed = record;
        await store.putRuntimeState(record.key, record.value);
        return 'recorded';
      }),
    ).toBe(true);
    expect(handed?.key).toBe('edge.seen.dev_b');
    // It said it wrote the record itself — the registry does not write it a second time
    expect(store.writes.filter((key) => key === 'edge.seen.dev_b')).toHaveLength(1);
    await expect(registry.once('dev_b', BOOT, 2, async () => Promise.reject(new Error('store down')))).rejects.toThrow('store down');
    // Not recorded in memory either: the resend is stored
    expect(await registry.once('dev_b', BOOT, 2, async () => undefined)).toBe(true);
  });
});

describe('device records', () => {
  const device = (name: string) => ({ publicKey: name.padEnd(43, 'A'), name, software: { name: 'edge', version: '1.1.0' } });

  it('a change to one device writes that device only, not every device with its read list', async () => {
    const store = new CountingStore();
    const registry = new EdgeRegistry(store);
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const { code } = await registry.createCode(null);
      ids.push(((await registry.register(code, device(name))) as { deviceId: string }).deviceId);
    }
    store.writes = [];
    await registry.update(ids[1]!, (d) => ({ ...d, state: 'paused' }));
    expect(store.writes).toEqual([`edge.device.${ids[1]}`]);
    // A restart reads them back
    const again = new EdgeRegistry(store);
    expect((await again.list()).map((d) => [d.deviceId, d.state])).toEqual(ids.map((id, i) => [id, i === 1 ? 'paused' : 'pending-approval']));
  });

  it('devices saved by 2.8.0 and older (one map) still load, and move to one record per device on the next change', async () => {
    const store = new CountingStore();
    const old = {
      dev_old1: { deviceId: 'dev_old1', ...device('x'), workspace: null, registeredAt: '2026-10-01T00:00:00.000Z', state: 'approved' },
      dev_old2: { deviceId: 'dev_old2', ...device('y'), workspace: null, registeredAt: '2026-10-02T00:00:00.000Z', state: 'pending-approval' },
    };
    await store.putRuntimeState('edge.devices', old);
    const registry = new EdgeRegistry(store);
    expect((await registry.list()).map((d) => d.deviceId)).toEqual(['dev_old1', 'dev_old2']);
    await registry.update('dev_old2', (d) => ({ ...d, state: 'paused' }));
    const restarted = new EdgeRegistry(store);
    expect((await restarted.list()).map((d) => [d.deviceId, d.state])).toEqual([
      ['dev_old1', 'approved'],
      ['dev_old2', 'paused'],
    ]);
    // The old map is gone once the records are written — it would otherwise come back after the next restart
    expect(await store.getRuntimeState('edge.devices')).toBeUndefined();
  });
});

describe('GET /edge/devices', () => {
  it('reads each file once per request, whatever the number of devices', async () => {
    const store = new CountingStore();
    await store.importPackage({ name: 'line1.aasx', package: withAid('RollFormingMachine') });
    const handle = createApi(store, { edge: { intervalMs: 1000 } });
    for (let i = 0; i < 5; i += 1) await connect(handle);
    store.environments = 0;
    const list = await adminOf(handle)('GET', '/edge/devices');
    expect((list.body as { items: { tags: number; changedSinceApproval: boolean }[] }).items).toHaveLength(5);
    expect((list.body as { items: { tags: number; changedSinceApproval: boolean }[] }).items.every((d) => d.tags === 2 && !d.changedSinceApproval)).toBe(true);
    expect(store.environments).toBe(1);
  });
});

describe('a batch across two files on PostgreSQL', () => {
  function logged(db: PGlite) {
    const statements: string[] = [];
    const client: SqlClient = {
      async query(text, params) {
        statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        return { rows: (await db.query(text, params as unknown[])).rows as never[] };
      },
    };
    return { client, statements };
  }

  it('is stored whole or not at all, with its idempotency record in the same transaction', async () => {
    const db = new PGlite();
    const { client, statements } = logged(db);
    const store = new PostgresStore(client);
    await store.init();
    const first = await store.importPackage({ name: 'line1.aasx', package: withAid('RollFormingMachine') });
    const second = await store.importPackage({ name: 'line2.aasx', package: withAid('PressMachine') });
    const handle = createApi(store, { edge: { intervalMs: 1000 } });
    const { edge } = await connect(handle);
    const list = await edge.readList();
    expect(list.interfaces).toHaveLength(2);

    // The second file refuses values: the first file's part of the same batch must not stay behind
    await db.query(`ALTER TABLE collected_value ADD CONSTRAINT refuse_second CHECK (package_id <> '${second.id}')`);
    edge.enqueue(list);
    expect(await edge.flush({ maxAttempts: 1 })).not.toBe('ok');
    expect(await store.readValues(first.id)).toEqual([]);

    await db.query('ALTER TABLE collected_value DROP CONSTRAINT refuse_second');
    statements.length = 0;
    expect(await edge.flush()).toBe('ok');
    expect(await store.readValues(first.id)).toHaveLength(2);
    expect(await store.readValues(second.id)).toHaveLength(2);
    // One transaction: the values of both files and the record that the batch was stored, then COMMIT
    const begin = statements.indexOf('BEGIN');
    const commit = statements.indexOf('COMMIT', begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    const inside = statements.slice(begin, commit);
    expect(inside.filter((s) => s.startsWith('INSERT INTO collected_value'))).toHaveLength(2);
    expect(inside.filter((s) => s.startsWith('INSERT INTO integration_state'))).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith('INSERT INTO collected_value'))).toHaveLength(2);
  });
});
