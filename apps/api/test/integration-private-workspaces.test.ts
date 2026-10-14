/**
 * Private workspaces across every integration route family (design §3.6, review H3).
 *
 * Important: the API is built exactly as in production — createApi with the built-in integration route builders,
 *    which receive the **scoped** store. Bob must never see Alice's package: a 404 or an empty list, never her data.
 *    Each family also has a positive control (Alice sees her own), so a route that answers nothing for everyone
 *    cannot pass by accident.
 */
import { readFileSync } from 'node:fs';

import { EVENT_TYPES } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApi } from '../src/api.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';
import { hashPassword } from '../src/password.js';
import { testServices } from './helpers/integration-scenarios.js';

const PASSWORD = '열자가넘는비밀번호입니다';
const ASSET_ID = 'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0';
const WINDOW = { from: '2026-10-13T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' };

type Caller = (method: string, path: string, init?: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }) => Promise<ApiResponse>;

let alice: Caller;
let bob: Caller;
let packageId: string;

beforeAll(async () => {
  const store = new InMemoryStore();
  await store.init();
  for (const login of ['alice', 'bob']) {
    await store.createUser({ login, displayName: login, role: 'editor', passwordHash: await hashPassword(PASSWORD) });
  }
  const handle = createApi(store, { privateWorkspaces: true, integrationServices: testServices(), collectIntervalMs: 60_000 });
  const as = async (login: string): Promise<Caller> => {
    const reply = await handle({ method: 'POST', path: '/auth/login', query: {}, headers: {}, body: { login, password: PASSWORD } } as ApiRequest);
    const cookie = String(reply.headers['set-cookie']).split(';')[0]!;
    return (method, path, init = {}) =>
      handle({ method, path, query: init.query ?? {}, queryAll: {}, headers: { cookie, ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) } as ApiRequest);
  };
  alice = await as('alice');
  bob = await as('bob');
  const upload = await alice('POST', '/packages', {
    query: { name: 'alice.aasx' },
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')),
  });
  expect(upload.status).toBe(201);
  packageId = (upload.body as { packageId: string }).packageId;
  // Something to export and something for the runtime routes to look at
  const config = await alice('PUT', `/packages/${packageId}/integration-config`, {
    headers: { 'if-match': '"0"' },
    body: { schema: 'vexplor.packageIntegrationConfig/1', state: { property: 'MachineState', interfaceName: null, rules: null }, counters: [{ id: 'produced', property: 'ProductionCount', kind: 'total' }] },
  });
  expect(config.status).toBe(200);
});

const text = (response: ApiResponse): string => (response.body instanceof Uint8Array ? new TextDecoder().decode(response.body) : JSON.stringify(response.body));
/**
 * Bob's answer must not carry Alice's data: her asset id anywhere, or her package id in a successful answer.
 * (A 404 that repeats the id Bob himself asked for reveals nothing.)
 */
const leaks = (response: ApiResponse): boolean =>
  text(response).includes(ASSET_ID) || (response.status < 300 && text(response).includes(packageId));

describe('exports and readiness', () => {
  it('equipment list: Alice sees her unit, Bob an empty list', async () => {
    expect(leaks(await alice('GET', '/integrations/exports/equipment'))).toBe(true);
    const listed = await bob('GET', '/integrations/exports/equipment');
    expect(listed.status).toBe(200);
    expect(leaks(listed)).toBe(false);
  });

  it.each(['equipment', 'bom', 'hierarchy', 'maintenance', 'documents'])('exports/%s?packageId=<Alice> → 404 for Bob', async (kind) => {
    const reply = await bob('GET', `/integrations/exports/${kind}`, { query: { packageId } });
    expect(reply.status).toBe(404);
    expect(leaks(reply)).toBe(false);
  });

  it('readiness: no Alice item for Bob; her package id → 404', async () => {
    expect(leaks(await alice('GET', '/integrations/readiness'))).toBe(true);
    const all = await bob('GET', '/integrations/readiness');
    expect(all.status).toBe(200);
    expect(leaks(all)).toBe(false);
    expect((await bob('GET', '/integrations/readiness', { query: { packageId } })).status).toBe(404);
  });
});

describe('runtime data (segments, OEE inputs, meters)', () => {
  it.each([
    ['/integrations/equipment/segments', {}],
    ['/integrations/equipment/oee-inputs', {}],
    ['/integrations/meters', { counter: 'produced' }],
  ])('%s for Alice works, for Bob → 404', async (path, extra) => {
    const query = { packageId, ...WINDOW, ...extra };
    expect((await alice('GET', path, { query })).status).toBe(200);
    const reply = await bob('GET', path, { query });
    expect(reply.status).toBe(404);
    expect(leaks(reply)).toBe(false);
  });

  it("package integration config: Bob can neither read nor write Alice's", async () => {
    expect((await bob('GET', `/packages/${packageId}/integration-config`)).status).toBe(404);
    expect((await bob('PUT', `/packages/${packageId}/integration-config`, { headers: { 'if-match': '"1"' }, body: { schema: 'vexplor.packageIntegrationConfig/1' } })).status).toBe(404);
  });
});

describe('external references', () => {
  const doc = { schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'asset', globalAssetId: ASSET_ID }, refs: [{ system: 'erp:TEST', type: 'equipment', id: 'EQ-1' }] }] };

  it("GET / PUT of Alice's refs → 404 for Bob, nothing written", async () => {
    expect((await alice('GET', `/packages/${packageId}/external-refs`)).status).toBe(200);
    expect((await bob('GET', `/packages/${packageId}/external-refs`)).status).toBe(404);
    expect((await bob('PUT', `/packages/${packageId}/external-refs`, { headers: { 'if-match': '"0"' }, body: doc })).status).toBe(404);
    const after = await alice('GET', `/packages/${packageId}/external-refs`);
    expect((after.body as { revision: number }).revision).toBe(0);
  });

  it("import by Alice's asset id finds no package for Bob (row error), changes nothing", async () => {
    const rows = { rows: [{ globalAssetId: ASSET_ID, subjectKind: 'asset', system: 'erp:TEST', type: 'equipment', id: 'EQ-2' }] };
    const dry = await bob('POST', '/integrations/external-refs/import', { query: { dryRun: '1' }, body: rows });
    expect(dry.status).toBe(200);
    expect((dry.body as { changes: unknown[]; errors: unknown[] }).changes).toEqual([]);
    expect((dry.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    // The error row repeats the asset id Bob sent — but never names Alice's package
    expect(text(dry)).not.toContain(packageId);
    const applied = await bob('POST', '/integrations/external-refs/import', { body: rows });
    expect(applied.status).toBe(422);
    expect(text(applied)).not.toContain(packageId);
    // Positive control: the same row works for Alice
    const own = await alice('POST', '/integrations/external-refs/import', { query: { dryRun: '1' }, body: rows });
    expect((own.body as { changes: unknown[] }).changes).toHaveLength(1);
  });
});

describe('event feed', () => {
  it("Alice sees her package's events, Bob none of them", async () => {
    const own = await alice('GET', '/integrations/events');
    const types = (own.body as { items: { type: string; vxpackageid?: string }[] }).items.filter((item) => item.vxpackageid === packageId).map((item) => item.type);
    expect(types).toContain(EVENT_TYPES.modelPackageCreated);
    const other = await bob('GET', '/integrations/events');
    expect(other.status).toBe(200);
    expect(leaks(other)).toBe(false);
    expect((await bob('GET', '/integrations/events', { query: { packageId } })).body).toMatchObject({ items: [] });
  });
});
