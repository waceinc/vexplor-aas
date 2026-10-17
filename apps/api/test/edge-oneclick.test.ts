/**
 * One-click connection (2.7.0): a person approves the read list when making the code, the edge registers with it and
 * starts reading without a second visit; the screen sees when each device last sent; a paused device resumes; and an
 * admin turns the edge on from the screen when EDGE is not set.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi, type ApiRequest, type ApiResponse } from '@aas/api';
import { compile, match } from '../src/router.js';
import { toErrorResponse } from '../src/api.js';
import { edgeAdminRoutes } from '../src/edge/routes-edge-admin.js';
import { EdgeRegistry } from '../src/edge/state.js';
import { createMockEdge } from '../../../scripts/mock-edge.mjs';
import { ADMIN, EDITOR, type Principal } from './helpers/integration-scenarios.js';

const golden = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

function withAid(assetName = 'RollFormingMachine', tags = [{ name: 'SpindleSpeed', href: 'ns=2;s=Machine.SpindleSpeed', type: 'float' }]) {
  const pkg = readAasx(golden);
  pkg.environment.submodels!.push(
    buildAidSubmodel({ assetName, iriBase: 'https://www.smart-factory.kr/ids', endpoint: 'opc.tcp://192.168.10.21:4840', tags }) as never,
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

async function setup(edge: { mode?: 'on' | 'switchable' } = {}) {
  const store = new InMemoryStore();
  const record = await store.importPackage({ name: 'line1.aasx', package: withAid() });
  const handle = createApi(store, { edge: { intervalMs: 1000, ...edge } });
  const admin = async (method: string, path: string, body?: unknown) =>
    handle({ method, path, query: {}, queryAll: {}, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  const edgeAgent = () =>
    createMockEdge({ server: 'http://edge.test', stateDir: mkdtempSync(join(tmpdir(), 'edge-')), fetchImpl: viaApi(handle), sleep: async () => undefined });
  return { store, packageId: record.id, handle, admin, edgeAgent };
}

type Device = {
  deviceId: string;
  state: string;
  approvedRevision: string | null;
  lastSeenAt: string | null;
  samplesReceived: number;
  lastStatus: { interfaces?: { interfaceId: string; connected: boolean }[] } | null;
};
const devices = async (admin: Awaited<ReturnType<typeof setup>>['admin']) => ((await admin('GET', '/edge/devices')).body as { items: Device[] }).items;

describe('one-click: approve when making the code', () => {
  it('a code made with the previewed revision registers an edge that reads at once', async () => {
    const { admin, edgeAgent } = await setup();
    const status = (await admin('GET', '/edge/status')).body as { current: { revision: string; tags: number; interfaces: number } };
    expect(status.current).toMatchObject({ tags: 1, interfaces: 1 });
    const made = await admin('POST', '/edge/registration-codes', { approve: { revision: status.current.revision } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ preapproved: { revision: status.current.revision, tags: 1 } });

    const edge = edgeAgent();
    await edge.register((made.body as { code: string }).code);
    const list = await edge.readList();
    expect(list.state).toBe('approved');
    expect(list.interfaces[0]!.tags).toHaveLength(1);
    expect(list.pollSeconds).toBe(60);
    expect((await devices(admin))[0]).toMatchObject({ state: 'approved', approvedVia: 'code' });
  });

  it('refuses to make a pre-approved code for a list the person did not see', async () => {
    const { admin } = await setup();
    const made = await admin('POST', '/edge/registration-codes', { approve: { revision: 'stale' } });
    expect(made.status).toBe(409);
  });

  it('a code without approval still waits for a person, as before', async () => {
    const { admin, edgeAgent } = await setup();
    const made = await admin('POST', '/edge/registration-codes');
    expect(made.body).not.toHaveProperty('preapproved');
    const edge = edgeAgent();
    await edge.register((made.body as { code: string }).code);
    const list = await edge.readList();
    expect(list.state).toBe('pending-approval');
    // Waiting for a person: it asks every 10 s so an approval reaches it quickly; approved: the normal minute
    expect(list.pollSeconds).toBe(10);
  });

  it('files changed after the code was made: the edge reads exactly what the person saw, and the screen says it changed', async () => {
    const { store, admin, edgeAgent } = await setup();
    const status = (await admin('GET', '/edge/status')).body as { current: { revision: string } };
    const code = ((await admin('POST', '/edge/registration-codes', { approve: { revision: status.current.revision } })).body as { code: string }).code;
    await store.importPackage({ name: 'line2.aasx', package: withAid('Press', [{ name: 'Force', href: 'ns=2;s=Press.Force', type: 'float' }]) });
    const edge = edgeAgent();
    await edge.register(code);
    const list = await edge.readList();
    expect(list.state).toBe('approved');
    expect(list.interfaces).toHaveLength(1);
    expect((await devices(admin))[0]).toMatchObject({ changedSinceApproval: true });
  });
});

describe('device activity and resume', () => {
  it('records when a device last sent, how many values, and its interface status', async () => {
    const { admin, edgeAgent } = await setup();
    const status = (await admin('GET', '/edge/status')).body as { current: { revision: string } };
    const code = ((await admin('POST', '/edge/registration-codes', { approve: { revision: status.current.revision } })).body as { code: string }).code;
    const edge = edgeAgent();
    await edge.register(code);
    expect((await devices(admin))[0]).toMatchObject({ lastSeenAt: null, samplesReceived: 0, lastStatus: null });
    const list = await edge.readList();
    edge.enqueue(list);
    expect(await edge.flush()).toBe('ok');
    const [device] = await devices(admin);
    expect(device!.lastSeenAt).not.toBeNull();
    expect(device!.samplesReceived).toBe(1);
    expect(device!.lastStatus?.interfaces?.[0]).toMatchObject({ connected: true });
  });

  it('a paused device resumes its approved list; a revoked or never approved one cannot', async () => {
    const { admin, edgeAgent } = await setup();
    const plain = ((await admin('POST', '/edge/registration-codes')).body as { code: string }).code;
    const waiting = edgeAgent();
    const { deviceId: pendingId } = await waiting.register(plain);
    expect((await admin('POST', `/edge/devices/${pendingId}/resume`)).status).toBe(409);

    const status = (await admin('GET', '/edge/status')).body as { current: { revision: string } };
    const code = ((await admin('POST', '/edge/registration-codes', { approve: { revision: status.current.revision } })).body as { code: string }).code;
    const edge = edgeAgent();
    const { deviceId } = await edge.register(code);
    expect((await admin('POST', `/edge/devices/${deviceId}/pause`)).status).toBe(200);
    expect((await edge.readList()).state).toBe('paused');
    const resumed = await admin('POST', `/edge/devices/${deviceId}/resume`);
    expect(resumed.status).toBe(200);
    expect((await edge.readList()).state).toBe('approved');
    await admin('POST', `/edge/devices/${deviceId}/revoke`);
    expect((await admin('POST', `/edge/devices/${deviceId}/resume`)).status).toBe(409);
  });
});

describe('turning the edge on from the screen', () => {
  it('switchable and off: the edge endpoints do not answer and no code can be made', async () => {
    const { admin, handle } = await setup({ mode: 'switchable' });
    expect((await admin('GET', '/edge/status')).body).toMatchObject({ enabled: false, switchable: true });
    expect((await admin('POST', '/edge/registration-codes')).status).toBe(409);
    const register = await handle({ method: 'POST', path: '/edge/v1/register', query: {}, queryAll: {}, headers: {}, body: {} });
    expect(register.status).toBe(404);
  });

  it('only an admin session turns it on; once on, the one-click flow works', async () => {
    const store = new InMemoryStore();
    await store.importPackage({ name: 'line1.aasx', package: withAid() });
    const registry = new EdgeRegistry(store);
    const routes = compile(edgeAdminRoutes({ registry, store, intervalMs: 1000, mode: 'switchable' }));
    const call = async (method: string, path: string, principal?: Principal, body?: unknown) => {
      const found = match(routes, method, path);
      if (found === undefined || found === 'method-not-allowed') return 404;
      const request: ApiRequest = { method, path, query: {}, headers: {}, ...(body === undefined ? {} : { body }), ...(principal ? { principal } : {}) };
      try {
        return (await found.route.handle({ request, params: found.params })).status;
      } catch (error) {
        return toErrorResponse(error).status;
      }
    };
    expect(await call('POST', '/edge/enable', undefined, { enabled: true })).toBe(403);
    expect(await call('POST', '/edge/enable', EDITOR, { enabled: true })).toBe(403);
    expect(await call('POST', '/edge/enable', ADMIN, { enabled: true })).toBe(200);
    expect(await registry.enabled()).toBe(true);
    expect(await call('POST', '/edge/registration-codes', ADMIN)).toBe(201);
    expect(await call('POST', '/edge/enable', ADMIN, { enabled: 'yes' })).toBe(400);
  });

  it('EDGE=on decides: the switch is locked', async () => {
    const { admin } = await setup({ mode: 'on' });
    expect((await admin('GET', '/edge/status')).body).toMatchObject({ enabled: true, switchable: false });
    const store = new InMemoryStore();
    const routes = compile(edgeAdminRoutes({ registry: new EdgeRegistry(store), store, intervalMs: 1000, mode: 'on' }));
    const found = match(routes, 'POST', '/edge/enable');
    if (found === undefined || found === 'method-not-allowed') throw new Error('route missing');
    const request: ApiRequest = { method: 'POST', path: '/edge/enable', query: {}, headers: {}, body: { enabled: false }, principal: ADMIN };
    const status = await found.route.handle({ request, params: found.params }).then((r) => r.status, (e: unknown) => toErrorResponse(e).status);
    expect(status).toBe(409);
  });
});
