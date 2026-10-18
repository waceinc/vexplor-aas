/**
 * The server's own state for an admin (2.8.0): store answering, disk left, what the remote collectors sent in the last
 * hour, version. Through the real request pipeline (sessions and roles), plus the store check and the hour counter alone.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRODUCT_VERSION } from '@aas/core';
import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore, type AasStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';
import { EdgeTraffic } from '../src/edge/traffic.js';
import { serverStatusRoutes } from '../src/routes/server-status.js';
import { hashPassword } from '../src/password.js';
import { compile, match } from '../src/router.js';
import { toErrorResponse } from '../src/api.js';
import { ADMIN } from './helpers/integration-scenarios.js';
import { createMockEdge } from '../../../scripts/mock-edge.mjs';

const PASSWORD = '열자가넘는비밀번호입니다';
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

async function harness() {
  const store = new InMemoryStore();
  await store.importPackage({ name: 'line1.aasx', package: withAid() });
  for (const [login, role] of [
    ['admin', 'admin'],
    ['viewer', 'viewer'],
  ] as const) {
    await store.createUser({ login, displayName: login, role, passwordHash: await hashPassword(PASSWORD) });
  }
  const api = createApi(store, { edge: { intervalMs: 1000 } });
  const cookies = new Map<string, string>();
  const call = async (method: string, path: string, as?: 'admin' | 'viewer', body?: unknown): Promise<ApiResponse> => {
    const headers: Record<string, string> = {};
    if (as) {
      if (!cookies.has(as)) {
        const login = await api({ method: 'POST', path: '/auth/login', query: {}, headers: {}, body: { login: as, password: PASSWORD } } as ApiRequest);
        cookies.set(as, (login.headers['set-cookie'] ?? '').split(';')[0]!);
      }
      Object.assign(headers, { cookie: cookies.get(as)!, origin: 'http://localhost', host: 'localhost' });
      if (body !== undefined) headers['content-type'] = 'application/json';
    }
    return api({ method, path, query: {}, headers, ...(body === undefined ? {} : { body }) } as ApiRequest);
  };
  return { api, call };
}

describe('GET /server/status', () => {
  it('admins see version, store, disk and the last hour of collector traffic; others do not', async () => {
    const { api, call } = await harness();
    // A collector sends two batches (one with a value for a tag it was not given) and one unsigned request is refused
    const code = ((await call('POST', '/edge/registration-codes', 'admin')).body as { code: string }).code;
    const edge = createMockEdge({
      server: 'http://edge.test',
      stateDir: mkdtempSync(join(tmpdir(), 'edge-')),
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        const text = typeof init.body === 'string' ? init.body : undefined;
        const answer = await api({
          method: init.method ?? 'GET',
          path: url.pathname,
          rawTarget: url.pathname + url.search,
          query: {},
          queryAll: {},
          headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
          ...(text !== undefined ? { body: JSON.parse(text) as unknown, rawBody: new TextEncoder().encode(text) } : {}),
        });
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
      },
    });
    const { deviceId } = await edge.register(code);
    const preview = (await call('GET', `/edge/devices/${deviceId}/read-list-preview`, 'admin')).body as { revision: string };
    expect((await call('POST', `/edge/devices/${deviceId}/approve`, 'admin', { revision: preview.revision })).status).toBe(200);
    const list = await edge.readList();
    edge.enqueue(list);
    edge.enqueue(list, [{ tagId: 'tag_unknown', observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), value: 1 }]);
    expect(await edge.flush()).toBe('ok');
    expect((await api({ method: 'POST', path: '/edge/v1/batches', query: {}, headers: {}, body: {} } as ApiRequest)).status).toBe(401);

    const status = await call('GET', '/server/status', 'admin');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      version: PRODUCT_VERSION,
      store: { kind: 'memory', ok: true },
      disk: { of: 'server' },
      edge: { batches: 2, refused: 1, samplesRejected: 1, sinceStart: true },
    });
    const disk = (status.body as { disk: { freeBytes: number; totalBytes: number; freePercent: number } }).disk;
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.freePercent).toBeGreaterThanOrEqual(0);
    expect(disk.freePercent).toBeLessThanOrEqual(100);

    expect((await call('GET', '/server/status', 'viewer')).status).toBe(403);
    expect((await call('GET', '/server/status')).status).toBe(401);
  });

  it('without the remote collector, edge is null', async () => {
    const store = new InMemoryStore();
    await store.createUser({ login: 'admin', displayName: 'admin', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const api = createApi(store);
    const login = await api({ method: 'POST', path: '/auth/login', query: {}, headers: {}, body: { login: 'admin', password: PASSWORD } } as ApiRequest);
    const cookie = (login.headers['set-cookie'] ?? '').split(';')[0]!;
    const status = await api({ method: 'GET', path: '/server/status', query: {}, headers: { cookie } } as ApiRequest);
    expect(status.body).toMatchObject({ edge: null, store: { ok: true } });
  });
});

describe('the store check and the disk', () => {
  const ask = async (options: Parameters<typeof serverStatusRoutes>[0]) => {
    const found = match(compile(serverStatusRoutes(options)), 'GET', '/server/status');
    if (found === undefined || found === 'method-not-allowed') throw new Error('route missing');
    const request: ApiRequest = { method: 'GET', path: '/server/status', query: {}, headers: {}, principal: ADMIN };
    return found.route.handle({ request, params: found.params }).then(
      (answer) => answer.body as Record<string, unknown>,
      (error: unknown) => toErrorResponse(error),
    );
  };

  it('a store that fails or hangs is reported, not waited on', async () => {
    const failing = { countUsers: () => Promise.reject(new Error('connection refused')) } as unknown as AasStore;
    expect(await ask({ store: failing, storeKind: 'postgres' })).toMatchObject({ store: { kind: 'postgres', ok: false, error: 'connection refused' } });
    const hanging = { countUsers: () => new Promise(() => undefined) } as unknown as AasStore;
    const started = Date.now();
    expect(await ask({ store: hanging, storeKind: 'postgres', storeTimeoutMs: 30 })).toMatchObject({ store: { ok: false } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a folder store reports the disk of its data folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-data-'));
    expect(await ask({ store: new InMemoryStore(), storeKind: 'folder', dataDir: dir })).toMatchObject({ disk: { of: 'data' } });
  });
});

describe('EdgeTraffic', () => {
  it('counts per minute and forgets what is older than an hour', () => {
    let now = Date.parse('2026-10-18T09:00:00.000Z');
    const traffic = new EdgeTraffic(() => now);
    traffic.record(200, { rejected: [{}, {}] });
    traffic.record(422, {});
    now += 30 * 60_000;
    traffic.record(200, { rejected: [] });
    expect(traffic.lastHour()).toEqual({ batches: 2, refused: 1, samplesRejected: 2 });
    now += 31 * 60_000;
    expect(traffic.lastHour()).toEqual({ batches: 1, refused: 0, samplesRejected: 0 });
    now += 60 * 60_000;
    expect(traffic.lastHour()).toEqual({ batches: 0, refused: 0, samplesRejected: 0 });
  });
});
