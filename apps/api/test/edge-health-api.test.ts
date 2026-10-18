/**
 * Collector health on the API (2.8.0): the device list carries the server's verdict (OK · Attention · Problem with the
 * reasons), and each collector's trend is kept per 5 minutes for 24 hours — in the store, so it survives a restart.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi, type ApiRequest, type ApiResponse } from '@aas/api';
import { EdgeRegistry } from '../src/edge/state.js';
import { createMockEdge } from '../../../scripts/mock-edge.mjs';

const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

function withAid() {
  const pkg = readAasx(golden);
  pkg.environment.submodels!.push(
    buildAidSubmodel({
      assetName: 'RollFormingMachine',
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: 'opc.tcp://192.168.10.21:4840',
      tags: [{ name: 'SpindleSpeed', href: 'ns=2;s=Machine.SpindleSpeed', type: 'float' }],
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

interface DeviceItem {
  deviceId: string;
  lastStatus: Record<string, unknown> | null;
  lastStatusAt: string | null;
  health: { level: string; reasons: { code: string; level: string; message: string }[] } | null;
}

async function connected() {
  const store = new InMemoryStore();
  await store.importPackage({ name: 'line1.aasx', package: withAid() });
  const handle = createApi(store, { edge: { intervalMs: 1000 } });
  const admin = async (method: string, path: string, body?: unknown) =>
    handle({ method, path, query: {}, queryAll: {}, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  const code = ((await admin('POST', '/edge/registration-codes')).body as { code: string }).code;
  const edge = createMockEdge({ server: 'http://edge.test', stateDir: mkdtempSync(join(tmpdir(), 'edge-')), fetchImpl: viaApi(handle), sleep: async () => undefined });
  const { deviceId } = await edge.register(code);
  const preview = (await admin('GET', `/edge/devices/${deviceId}/read-list-preview`)).body as { revision: string };
  await admin('POST', `/edge/devices/${deviceId}/approve`, { revision: preview.revision });
  const list = await edge.readList();
  const item = async (): Promise<DeviceItem> => ((await admin('GET', '/edge/devices')).body as { items: DeviceItem[] }).items.find((d) => d.deviceId === deviceId)!;
  const send = async (statusExtra: Record<string, unknown> = {}) => {
    edge.enqueue(list, [], statusExtra);
    expect(await edge.flush()).toBe('ok');
  };
  return { store, admin, deviceId, list, item, send };
}

const host = (change: Record<string, unknown> = {}) => ({
  host: { cpuPercent: 7, memoryUsedPercent: 41, diskFreeBytes: 5e10, diskFreePercent: 70, uptimeSeconds: 9000, processUptimeSeconds: 60, clockOffsetMs: 200, queuedInMemory: 0, ...change },
  server: { lastSendOkAt: new Date().toISOString(), lastSendError: null, lastSendErrorAt: null, sendFailuresSinceOk: 0, roundTripMs: 40, oldestQueuedAt: null },
  software: { name: 'vexplor-edge', version: '1.1.0' },
});

describe('device list — the verdict', () => {
  it('an edge 1.1.0 status is kept whole and judged; a healthy one is OK', async () => {
    const { item, send } = await connected();
    await send(host());
    const device = await item();
    expect(device.health).toEqual({ level: 'ok', reasons: [] });
    expect(device.lastStatus?.['host']).toMatchObject({ diskFreePercent: 70, clockOffsetMs: 200 });
    expect(device.lastStatusAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('low disk is Attention with its reason, a nearly full one is Problem — and recovery returns to OK', async () => {
    const { item, send } = await connected();
    await send(host({ diskFreePercent: 6.4 }));
    expect((await item()).health).toMatchObject({ level: 'attention', reasons: [{ code: 'disk-low', level: 'attention' }] });
    expect((await item()).health!.reasons[0]!.message).toMatch(/6\.4%/);
    await send(host({ diskFreePercent: 1.2 }));
    expect((await item()).health).toMatchObject({ level: 'problem', reasons: [{ code: 'disk-full' }] });
    await send(host());
    expect((await item()).health?.level).toBe('ok');
  });

  it('no equipment connected is Problem', async () => {
    const { item, list, send } = await connected();
    await send({ interfaces: list.interfaces.map((iface) => ({ interfaceId: iface.interfaceId, connected: false, lastError: 'ECONNREFUSED' })) });
    expect((await item()).health).toMatchObject({ level: 'problem', reasons: [{ code: 'no-equipment' }] });
  });

  it('an edge 1.0.x status (no host, no server) is judged on what it sends', async () => {
    const { item, send } = await connected();
    await send();
    const device = await item();
    expect(device.health).toEqual({ level: 'ok', reasons: [] });
    expect(device.lastStatus?.['host']).toBeUndefined();
  });

  it('a paused collector is shown by its state, not judged', async () => {
    const { admin, deviceId, item, send } = await connected();
    await send(host({ diskFreePercent: 1 }));
    await admin('POST', `/edge/devices/${deviceId}/pause`);
    expect((await item()).health).toBeNull();
  });

  it('the trend of a collector is one call away; an unknown collector is 404', async () => {
    const { admin, deviceId, send } = await connected();
    await send(host({ diskFreePercent: 50 }));
    await send(host({ diskFreePercent: 49 }));
    const trend = (await admin('GET', `/edge/devices/${deviceId}/history`)).body as { items: { values: number; disk?: number; links?: unknown[] }[] };
    expect(trend.items.length).toBeGreaterThanOrEqual(1);
    const last = trend.items.at(-1)!;
    expect(last.disk).toBe(49);
    expect(trend.items.reduce((sum, point) => sum + point.values, 0)).toBe(2);
    expect(last.links).toHaveLength(1);
    expect((await admin('GET', '/edge/devices/dev_nope/history')).status).toBe(404);
  });
});

describe('trend kept in the store', () => {
  const T0 = Date.parse('2026-10-18T09:00:00.000Z');
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const status = (disk: number) => ({ queuedBatches: 0, droppedBatches: 0, host: { diskFreePercent: disk } });

  it('one point per 5 minutes by when the batch was made, values added up, older than 24 h dropped, kept across a restart', async () => {
    const store = new InMemoryStore();
    let now = T0 + 60 * 60_000;
    const registry = new EdgeRegistry(store, () => new Date(now));
    // An outage: batches made at minute 1, 2 and 7 arrive together at minute 60, in order
    await registry.recordActivity('dev_a', 2, status(80), at(1));
    await registry.recordActivity('dev_a', 3, status(79), at(2));
    await registry.recordActivity('dev_a', 1, status(78), at(7));
    let points = await registry.history('dev_a');
    expect(points.map((point) => [point.at, point.values, point.disk])).toEqual([
      [at(2), 5, 79],
      [at(7), 1, 78],
    ]);
    // A batch dated in the future is filed at the arrival time
    await registry.recordActivity('dev_a', 1, status(77), at(600));
    expect((await registry.history('dev_a')).at(-1)!.at).toBe(at(60));
    // A day later, the outage points are gone
    now += 24 * 3_600_000;
    await registry.recordActivity('dev_a', 1, status(70), new Date(now).toISOString());
    points = await registry.history('dev_a');
    expect(points.every((point) => Date.parse(point.at) >= now - 24 * 3_600_000)).toBe(true);
    expect(points.at(-1)!.disk).toBe(70);
    // Written to the store with the activity — a new registry (a restart) reads the same trend
    expect(await new EdgeRegistry(store).history('dev_a')).toEqual(points);
  });

  it('stays bounded however many batches arrive', async () => {
    const store = new InMemoryStore();
    let now = T0;
    const registry = new EdgeRegistry(store, () => new Date(now));
    for (let minute = 0; minute < 3 * 24 * 60; minute += 2) {
      now = T0 + minute * 60_000;
      await registry.recordActivity('dev_b', 1, status(50), new Date(now).toISOString());
    }
    const points = await registry.history('dev_b');
    expect(points.length).toBeLessThanOrEqual(24 * 12 + 1);
    expect(points.length).toBeGreaterThan(280);
  });

  it('a resent older batch does not replace the newer status shown', async () => {
    const store = new InMemoryStore();
    const registry = new EdgeRegistry(store, () => new Date(T0 + 3_600_000));
    await registry.recordActivity('dev_c', 1, status(60), at(30));
    await registry.recordActivity('dev_c', 0, status(90), at(10));
    expect((await registry.activity('dev_c'))?.lastStatus).toMatchObject({ host: { diskFreePercent: 60 } });
    expect((await registry.activity('dev_c'))?.lastStatusAt).toBe(at(30));
  });
});
