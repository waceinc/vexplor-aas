/**
 * Integration config, runtime equipment and OPC UA certificate routes (design §4.3, §4.6, D11) through the real request
 * pipeline (`createApi`: sessions, roles, API keys), plus the OPC UA account check used in secure mode.
 */
import type { CollectedValue } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import type { IntegrationRouteDeps, OpcUaPki } from '../src/integration/deps.js';
import { equipmentRoutes, MAX_PERIODS, type EquipmentRouteOptions } from '../src/integration/routes-equipment.js';
import { deviceCounterReadings } from '../src/integration/runtime/meters.js';
import { opcuaRoutes } from '../src/integration/routes-opcua.js';
import { hashPassword } from '../src/password.js';
import { accountVerifier } from '../src/publisher.js';
import { LoginThrottle } from '../src/session.js';
import { runtimeStore, seededPackage, type RuntimeStore } from './helpers/integration-runtime.js';

const NOW = Date.parse('2026-10-15T00:00:00.000Z');
const PASSWORD = '열자가넘는비밀번호입니다';
const FULL_KEY = 'full-key-123';

interface Call {
  status: number;
  body: any;
  headers: Record<string, string>;
}

async function harness(options: { pki?: OpcUaPki; keys?: boolean; routes?: EquipmentRouteOptions } = {}) {
  const store = await runtimeStore();
  const record = await seededPackage(store);
  for (const [login, role] of [
    ['admin', 'admin'],
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ] as const) {
    await store.createUser({ login, displayName: login, role, passwordHash: await hashPassword(PASSWORD) });
  }
  const deps: IntegrationRouteDeps = {
    demo: false,
    collectIntervalMs: 60_000,
    ...(options.pki ? { runtime: { status: () => ({ enabled: true, running: [] }), opcuaPki: () => options.pki } } : {}),
  };
  const api = createApi(store, {
    // These tests mount the equipment routes themselves (fixed clock, own deps) — not the built-in ones
    integrationRouteBuilders: {},
    routes: [...equipmentRoutes(store, deps, { now: () => NOW, ...options.routes }), ...opcuaRoutes(store, deps)],
    ...(options.keys ? { auth: { tokens: [FULL_KEY], readOnlyTokens: [] } } : {}),
  });
  const cookies = new Map<string, string>();
  const call = async (
    method: string,
    path: string,
    init: { as?: 'admin' | 'editor' | 'viewer'; key?: string; body?: unknown; query?: Record<string, string>; ifMatch?: string } = {},
  ): Promise<Call> => {
    const headers: Record<string, string> = {};
    if (init.as) {
      if (!cookies.has(init.as)) {
        const login = await api({ method: 'POST', path: '/auth/login', query: {}, headers: {}, body: { login: init.as, password: PASSWORD } } as ApiRequest);
        cookies.set(init.as, (login.headers['set-cookie'] ?? '').split(';')[0]!);
      }
      headers['cookie'] = cookies.get(init.as)!;
      // CSRF guard: a cookie write must come from the same origin
      headers['origin'] = 'http://localhost';
      headers['host'] = 'localhost';
    }
    if (init.key) headers['authorization'] = `Bearer ${init.key}`;
    if (init.ifMatch !== undefined) headers['if-match'] = init.ifMatch;
    const response = await api({ method, path, query: init.query ?? {}, headers, ...(init.body === undefined ? {} : { body: init.body }) } as ApiRequest);
    return { status: response.status, body: response.body as any, headers: response.headers };
  };
  return { store, record, call };
}

const SERVER_BODY = {
  schema: 'vexplor.serverIntegrationConfig/1',
  stateRules: { run: ['run', '가동'], stop: ['stop'], alarm: ['alarm'], off: ['off'] },
  timezone: 'Asia/Seoul',
  dayStartHour: 8,
  shifts: [
    { name: 'A', start: '08:00', end: '20:00' },
    { name: 'B', start: '20:00', end: '08:00' },
  ],
};

const PACKAGE_BODY = {
  schema: 'vexplor.packageIntegrationConfig/1',
  state: { property: 'MachineState' },
  counters: [{ id: 'produced', property: 'ProductionCount', kind: 'total', unit: 'ea' }],
};

describe('server integration config', () => {
  it('reads defaults with revision 0 before anything is saved', async () => {
    const { call } = await harness();
    const read = await call('GET', '/integrations/config', { as: 'viewer' });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ revision: 0, value: { timezone: 'Asia/Seoul', dayStartHour: 8, shifts: [] } });
    expect(read.headers['etag']).toBe('"0"');
  });

  it('only an admin session may write: editor, viewer and a full API key get 403', async () => {
    const { call } = await harness({ keys: true });
    for (const as of ['editor', 'viewer'] as const) {
      expect((await call('PUT', '/integrations/config', { as, body: SERVER_BODY, ifMatch: '"0"' })).status).toBe(403);
    }
    expect((await call('PUT', '/integrations/config', { key: FULL_KEY, body: SERVER_BODY, ifMatch: '"0"' })).status).toBe(403);
    expect((await call('PUT', '/integrations/config', { as: 'admin', body: SERVER_BODY, ifMatch: '"0"' })).status).toBe(200);
  });

  it('If-Match: 428 without, 412 stale; instanceId is server-owned; an audit event is recorded', async () => {
    const { call, store } = await harness();
    expect((await call('PUT', '/integrations/config', { as: 'admin', body: SERVER_BODY })).status).toBe(428);
    const saved = await call('PUT', '/integrations/config', { as: 'admin', body: { ...SERVER_BODY, instanceId: 'aaaaaaaaaaaa' }, ifMatch: '"0"' });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    const instanceId = saved.body.value.instanceId as string;
    expect(instanceId).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId).not.toBe('aaaaaaaaaaaa');
    expect((await call('PUT', '/integrations/config', { as: 'admin', body: SERVER_BODY, ifMatch: '"0"' })).status).toBe(412);
    const again = await call('PUT', '/integrations/config', { as: 'admin', body: { ...SERVER_BODY, instanceId: 'bbbbbbbbbbbb' }, ifMatch: 'W/"1"' });
    expect(again.body.value.instanceId).toBe(instanceId);
    const audit = (await store.readEvents({ after: 0, limit: 100, includeAudit: true })).items.filter((event) => event.type.endsWith('integration.audit.v1'));
    expect(audit).toHaveLength(2);
    expect(audit[0]!.data).toMatchObject({ action: 'config.updated', target: 'server', actor: { name: 'admin' } });
  });

  it('validation errors answer 400 with JSON Pointers', async () => {
    const { call } = await harness();
    const bad = await call('PUT', '/integrations/config', { as: 'admin', body: { ...SERVER_BODY, dayStartHour: 25, extra: 1 }, ifMatch: '"0"' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((error: { path: string }) => error.path).sort()).toEqual(['/dayStartHour', '/extra']);
  });
});

describe('package integration config', () => {
  it('GET before saving is null with revision 0; an editor saves; a viewer cannot; unknown package 404', async () => {
    const { call, record } = await harness();
    const path = `/packages/${record.id}/integration-config`;
    expect((await call('GET', path, { as: 'viewer' })).body).toEqual({ value: null, revision: 0 });
    expect((await call('PUT', path, { as: 'viewer', body: PACKAGE_BODY, ifMatch: '"0"' })).status).toBe(403);
    const saved = await call('PUT', path, { as: 'editor', body: PACKAGE_BODY, ifMatch: '"0"' });
    expect(saved.status).toBe(200);
    expect(saved.headers['etag']).toBe('"1"');
    expect(saved.body.value).toMatchObject({ state: { property: 'MachineState', interfaceName: null, rules: null }, connection: { lostAfterFailures: 2 } });
    expect((await call('PUT', path, { as: 'editor', body: PACKAGE_BODY, ifMatch: '"0"' })).status).toBe(412);
    expect((await call('PUT', path, { as: 'editor', body: { ...PACKAGE_BODY, alarms: [{ id: 'a' }] }, ifMatch: '"1"' })).body.errors[0].path).toBe('/alarms/0/property');
    expect((await call('GET', '/packages/missing/integration-config', { as: 'viewer' })).status).toBe(404);
  });
});

/** Package with a saved config and values: 10 min run, 5 min stop on the production day 2026-10-14 (KST) */
async function withData(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  await h.call('PUT', '/integrations/config', { as: 'admin', body: SERVER_BODY, ifMatch: '"0"' });
  await h.call('PUT', `/packages/${h.record.id}/integration-config`, { as: 'editor', body: PACKAGE_BODY, ifMatch: '"0"' });
  const dayStart = Date.parse('2026-10-13T23:00:00.000Z');
  const values: CollectedValue[] = [];
  const add = (minute: number, property: string, value: string | number): void => {
    const at = new Date(dayStart + minute * 60_000).toISOString();
    values.push({ packageId: h.record.id, interfaceName: 'PLC1', propertyName: property, observedAt: at, receivedAt: at, ...(typeof value === 'number' ? { valueNumber: value } : { valueText: value }) });
  };
  for (let minute = 0; minute < 15; minute++) {
    add(minute, 'MachineState', minute < 10 ? 'run' : 'stop');
    add(minute, 'ProductionCount', 1000 + Math.min(minute, 10) * 6);
  }
  // Next production day (starts 2026-10-14T23:00Z): a reset
  add(24 * 60 + 1, 'ProductionCount', 1060);
  add(24 * 60 + 2, 'ProductionCount', 5);
  await h.store.appendValues(h.record.id, values);
  return { ...h, dayStart };
}

describe('segments, OEE inputs, meters', () => {
  it('segments: 409 without a state tag, 400 beyond 31 days, totals otherwise', async () => {
    const { call, record } = await harness();
    const query = { packageId: record.id, from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T23:00:00.000Z' };
    expect((await call('GET', '/integrations/equipment/segments', { as: 'viewer', query })).status).toBe(409);
    const data = await withData();
    expect((await data.call('GET', '/integrations/equipment/segments', { as: 'viewer', query: { ...query, packageId: data.record.id, to: '2026-11-20T00:00:00.000Z' } })).status).toBe(400);
    const segments = await data.call('GET', '/integrations/equipment/segments', { as: 'viewer', query: { ...query, packageId: data.record.id } });
    expect(segments.status).toBe(200);
    expect(segments.body).toMatchObject({ property: 'MachineState', holdMs: 5 * 60_000 });
    expect(segments.body.totals.run).toBe(10 * 60_000);
    // Stop samples at minutes 10–14, the last one held for the 5 min fresh window
    expect(segments.body.totals.stop).toBe(9 * 60_000);
    expect(segments.body.segments[0]).toEqual({ from: '2026-10-13T23:00:00.000Z', to: '2026-10-13T23:10:00.000Z', state: 'run' });
  });

  it('OEE inputs by production day and by shift', async () => {
    const { call, record } = await withData();
    const day = await call('GET', '/integrations/equipment/oee-inputs', { as: 'viewer', query: { packageId: record.id, day: '2026-10-14' } });
    expect(day.status).toBe(200);
    expect(day.body).toMatchObject({ window: { from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T23:00:00.000Z', timezone: 'Asia/Seoul' }, runMs: 600_000, resolutionMs: 60_000 });
    expect(day.body.produced).toEqual({ delta: 60, resets: 0, counterId: 'produced' });
    const shiftB = await call('GET', '/integrations/equipment/oee-inputs', { as: 'viewer', query: { packageId: record.id, day: '2026-10-14', shift: 'B' } });
    expect(shiftB.body).toMatchObject({ runMs: 0, produced: { delta: null } });
    expect((await call('GET', '/integrations/equipment/oee-inputs', { as: 'viewer', query: { packageId: record.id, day: '2026-10-14', shift: 'C' } })).status).toBe(400);
    expect((await call('GET', '/integrations/equipment/oee-inputs', { as: 'viewer', query: { packageId: record.id, day: '2026-02-30' } })).status).toBe(400);
  });

  it('meters: one device-counter reading per day, deterministic ids, a reset makes the delta unknown', async () => {
    const { call, record } = await withData();
    const query = { packageId: record.id, counter: 'produced', from: '2026-10-13T23:00:00.000Z', to: '2026-10-15T23:00:00.000Z', period: 'day' };
    const first = await call('GET', '/integrations/meters', { as: 'viewer', query });
    expect(first.status).toBe(200);
    const [today, tomorrow] = first.body.readings;
    expect(today).toMatchObject({ meterId: 'produced', meterKind: 'deviceCounter', unit: 'ea', reading: 1060, delta: null, flags: { reset: false, simulated: false } });
    expect(tomorrow).toMatchObject({ reading: 5, delta: null, flags: { reset: true } });
    expect(today.readingId).toMatch(/^rdg_[0-9A-Z]{26}$/);
    expect(today.evidence).toContain(`/packages/${record.id}/values?property=ProductionCount`);
    const second = await call('GET', '/integrations/meters', { as: 'viewer', query });
    expect(second.body.readings.map((r: { readingId: string }) => r.readingId)).toEqual(first.body.readings.map((r: { readingId: string }) => r.readingId));
    expect((await call('GET', '/integrations/meters', { as: 'viewer', query: { ...query, counter: 'nope' } })).status).toBe(404);
    expect((await call('GET', '/integrations/meters', { as: 'viewer', query: { ...query, period: 'week' } })).status).toBe(400);
  });

  it('meters: the first reading has an unknown delta, later ones the sum of steps', async () => {
    const { call, record } = await withData();
    const hours = await call('GET', '/integrations/meters', { as: 'viewer', query: { packageId: record.id, counter: 'produced', from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T00:00:00.000Z', period: 'hour' } });
    expect(hours.body.readings).toHaveLength(1);
    // The first hour has no reading before it in the store: the change over it is unknown, not 60
    expect(hours.body.readings[0]).toMatchObject({ reading: 1060, delta: null });
    const later = await call('GET', '/integrations/meters', { as: 'viewer', query: { packageId: record.id, counter: 'produced', from: '2026-10-13T23:05:00.000Z', to: '2026-10-14T00:00:00.000Z', period: 'hour' } });
    // Previous reading at minute 4 (1024) is inside the read-back window: 1060 − 1024
    expect(later.body.readings[0]).toMatchObject({ reading: 1060, delta: 36 });
  });

  it('meters: computed run time per finished period', async () => {
    const { call, record } = await withData();
    const runtime = await call('GET', '/integrations/meters', { as: 'viewer', query: { packageId: record.id, counter: 'runtime', from: '2026-10-13T23:00:00.000Z', to: '2026-10-15T23:00:00.000Z' } });
    expect(runtime.status).toBe(200);
    // The second production day ends after NOW, so only the first is reported
    expect(runtime.body.readings).toHaveLength(1);
    expect(runtime.body.readings[0]).toMatchObject({ meterKind: 'computedRunTime', unit: 's', reading: 600, runningSeconds: 600, stoppedSeconds: 540 });
  });
});

describe('OPC UA certificate routes', () => {
  const pki = (): OpcUaPki & { trusted: string[] } => {
    const trusted: string[] = [];
    const rejected = ['a'.repeat(40)];
    return {
      trusted,
      list: async () => ({
        trusted: trusted.map((thumbprint) => ({ thumbprint, subject: 'CN=MES', file: '/secret/path.der' })),
        rejected: rejected.filter((t) => !trusted.includes(t)).map((thumbprint) => ({ thumbprint, subject: 'CN=MES', file: '/secret/path.der' })),
      }),
      trust: async (thumbprint) => {
        if (!rejected.includes(thumbprint)) return false;
        trusted.push(thumbprint);
        return true;
      },
    };
  };

  it('409 when there is no trust store (OPC UA off or insecure)', async () => {
    const { call } = await harness();
    expect((await call('GET', '/integrations/opcua/certificates', { as: 'admin' })).status).toBe(409);
  });

  it('admin lists and trusts; editors are refused; file paths are not shown; trusting is audited', async () => {
    const store = pki();
    const { call, store: events } = await harness({ pki: store });
    expect((await call('GET', '/integrations/opcua/certificates', { as: 'editor' })).status).toBe(403);
    const listed = await call('GET', '/integrations/opcua/certificates', { as: 'admin' });
    expect(listed.body).toEqual({ trusted: [], rejected: [{ thumbprint: 'a'.repeat(40), subject: 'CN=MES', notAfter: null }] });
    expect((await call('POST', `/integrations/opcua/certificates/${'b'.repeat(40)}/trust`, { as: 'admin' })).status).toBe(404);
    expect((await call('POST', '/integrations/opcua/certificates/xyz/trust', { as: 'admin' })).status).toBe(400);
    expect((await call('POST', `/integrations/opcua/certificates/${'A'.repeat(40)}/trust`, { as: 'admin' })).status).toBe(200);
    expect(store.trusted).toEqual(['a'.repeat(40)]);
    const audit = (await events.readEvents({ after: 0, limit: 10, includeAudit: true })).items;
    expect(audit.at(-1)!.data).toMatchObject({ target: `opcua/certificates/${'a'.repeat(40)}`, details: { operation: 'trust' } });
  });
});

describe('bounded heavy reads (review M6, M5)', () => {
  it('a window with more values than one request may load answers 422', async () => {
    const { call, store, record } = await withData();
    const at = '2026-10-14T00:00:00.000Z';
    const flood = Array.from({ length: 200_001 }, (_, i) => ({ packageId: record.id, interfaceName: 'PLC1', propertyName: 'MachineState', observedAt: at, receivedAt: new Date(Date.parse(at) + i).toISOString(), valueText: 'run' }));
    Object.assign(store, { readValues: async () => flood });
    const response = await call('GET', '/integrations/equipment/segments', { as: 'viewer', query: { packageId: record.id, from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T23:00:00.000Z' } });
    expect(response.status).toBe(422);
    expect(response.body.messages[0].code).toBe('TooManyValues');
  });

  it('more periods than the cap answer 422; the default cap covers 31 days of hours', async () => {
    expect(MAX_PERIODS).toBeGreaterThanOrEqual(31 * 24);
    const { call, record } = await withData({ routes: { maxPeriods: 10 } });
    const response = await call('GET', '/integrations/meters', { as: 'viewer', query: { packageId: record.id, counter: 'produced', from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T11:00:00.000Z', period: 'hour' } });
    expect(response.status).toBe(422);
    expect(response.body.messages[0].code).toBe('TooManyPeriods');
  });

  it('a third concurrent heavy read is told to retry; once one finishes, a new one runs', async () => {
    const { call, store, record } = await withData();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = store.readValues.bind(store);
    Object.assign(store, { readValues: async (...args: Parameters<typeof read>) => (await gate, read(...args)) });
    const query = { packageId: record.id, from: '2026-10-13T23:00:00.000Z', to: '2026-10-14T23:00:00.000Z' };
    const first = call('GET', '/integrations/equipment/segments', { as: 'viewer', query });
    const second = call('GET', '/integrations/equipment/oee-inputs', { as: 'viewer', query: { packageId: record.id, day: '2026-10-14' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = await call('GET', '/integrations/meters', { as: 'viewer', query: { ...query, counter: 'produced' } });
    expect(third.status).toBe(503);
    expect(third.headers['retry-after']).toBe('5');
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await call('GET', '/integrations/meters', { as: 'viewer', query: { ...query, counter: 'produced' } })).status).toBe(200);
  });

  it('readings of an idle counter whose device time is frozen get one id per period', async () => {
    const hour = 3_600_000;
    const t0 = Date.parse('2026-10-14T00:00:00Z');
    const frozen = new Date(t0 + 10 * 60_000).toISOString();
    const values = [] as CollectedValue[];
    for (let minute = 10; minute < 180; minute += 20) {
      values.push({ packageId: 'pkg_1', interfaceName: 'PLC1', propertyName: 'Count', source: 's', observedAt: frozen, receivedAt: new Date(t0 + minute * 60_000).toISOString(), valueNumber: 500, quality: 'Good' });
    }
    const store = { readValues: async (_id: string, q?: { from?: string; to?: string }) => values.filter((v) => v.receivedAt! >= q!.from! && v.receivedAt! < q!.to!).reverse() };
    const readings = await deviceCounterReadings(
      { store, packageId: 'pkg_1', assetId: 'urn:a', environment: { submodels: [] } as never, interfaces: [], holdMs: hour, now: t0 + 4 * hour },
      { id: 'cnt', property: 'Count', kind: 'total', unit: null, max: null, maxRatePerHour: null },
      [0, 1, 2].map((i) => ({ start: t0 + i * hour, end: t0 + (i + 1) * hour })),
    );
    expect(readings).toHaveLength(3);
    expect(new Set(readings.map((r) => r.readingId)).size).toBe(3);
    // The delta of an idle counter is 0 once there is a previous reading
    expect(readings.map((r) => r.delta)).toEqual([null, 0, 0]);
  });
});

describe('OPC UA account check (secure mode)', () => {
  async function accounts(): Promise<RuntimeStore> {
    const store = await runtimeStore();
    await store.createUser({ login: 'operator', displayName: 'Operator', role: 'viewer', passwordHash: await hashPassword(PASSWORD) });
    const locked = await store.createUser({ login: 'locked', displayName: 'Locked', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    await store.updateUser(locked.id, { disabled: true });
    return store;
  }

  it('any role with the right password passes; wrong password, unknown and disabled accounts fail', async () => {
    const verify = accountVerifier(await accounts());
    expect(await verify('operator', PASSWORD)).toBe(true);
    expect(await verify('OPERATOR', PASSWORD)).toBe(true);
    expect(await verify('operator', 'wrong-password')).toBe(false);
    expect(await verify('nobody', PASSWORD)).toBe(false);
    expect(await verify('locked', PASSWORD)).toBe(false);
  });

  it('repeated failures block even the right password for a while', async () => {
    let now = 0;
    const verify = accountVerifier(await accounts(), new LoginThrottle(() => now));
    for (let i = 0; i < 5; i++) await verify('operator', 'wrong-password');
    expect(await verify('operator', PASSWORD)).toBe(false);
    now += 6 * 60_000;
    expect(await verify('operator', PASSWORD)).toBe(true);
  });

  it('failures are counted per client: one client guessing does not lock the account for another (review L5)', async () => {
    const verify = accountVerifier(await accounts(), new LoginThrottle(() => 0));
    const guesser = { certificateThumbprint: 'a'.repeat(40), address: '10.0.0.66' };
    const mes = { certificateThumbprint: 'b'.repeat(40), address: '10.0.0.10' };
    for (let i = 0; i < 5; i++) await verify('operator', 'wrong-password', guesser);
    expect(await verify('operator', PASSWORD, guesser)).toBe(false);
    expect(await verify('operator', PASSWORD, mes)).toBe(true);
    // Without a certificate the address is the slot
    for (let i = 0; i < 5; i++) await verify('operator', 'wrong-password', { address: '10.0.0.77' });
    expect(await verify('operator', PASSWORD, { address: '10.0.0.77' })).toBe(false);
    expect(await verify('operator', PASSWORD, { address: '10.0.0.78' })).toBe(true);
  });

  it('an unknown login takes as long as a wrong password for a real one (no existence oracle)', async () => {
    const verify = accountVerifier(await accounts(), new LoginThrottle(() => 0, 1000, 0, 1000, 0));
    await verify('nobody', 'x'); // warm the dummy hash
    const time = async (login: string): Promise<number> => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        await verify(login, 'wrong-password');
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const known = await time('operator');
    const unknown = await time('nobody');
    expect(unknown).toBeGreaterThan(known * 0.5);
  });
});
