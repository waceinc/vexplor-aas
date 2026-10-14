/**
 * Pull feed, rendering and schemas routes (design §2.1, §2.4, §4.1; CMMS T19, ERP E-21), plus the change cause of
 * requests and the 409 mapping of external-ref conflicts (§13.3 api.ts edits).
 */
import { ALL_EVENT_TYPES, EVENT_TYPES } from '@aas/core';
import { PGlite } from '@electric-sql/pglite';
import { ExternalRefConflictError, PostgresStore } from '@aas/store';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/api.js';
import { causeOf } from '../src/integration/change-context.js';
import { toCloudEvent } from '../src/integration/cloudevents.js';
import { ADMIN, clock, memoryStore, routeCaller, sampleRow, testServices, VIEWER } from './helpers/integration-scenarios.js';

const BASE = 'https://aas.plant.local/';

async function feed(storeKind: 'memory' | 'postgres' = 'memory') {
  const time = clock();
  const store = await memoryStore(time.iso);
  const call = routeCaller(store, { demo: false, publicBaseUrl: BASE, services: testServices({ now: time.now, storeKind }) });
  return { store, time, call };
}

const event = (n: number, type: string = EVENT_TYPES.equipmentStateChanged, packageId = 'pkg_1') => ({
  id: `evt_${String(n).padStart(26, '0')}`,
  type,
  time: '2026-10-14T00:00:00.000Z',
  packageId,
  subject: 'https://example.com/asset/1',
  data: { n },
});

describe('GET /integrations/events', () => {
  it('returns CloudEvents in seq order with cursors as strings', async () => {
    const { store, call } = await feed();
    await store.appendEvents([event(1), event(2), event(3)]);
    const reply = await call('GET', '/integrations/events?limit=2', { principal: VIEWER });
    expect(reply.status).toBe(200);
    expect(reply.body.items.map((item: { sequence: string }) => item.sequence)).toEqual(['00000000000000000001', '00000000000000000002']);
    expect(reply.body).toMatchObject({ nextAfter: '2', oldestSeq: '1' });
    expect(reply.body.items[0]).toMatchObject({ specversion: '1.0', source: 'urn:vexplor-aas:9f2c4e1a7b3d', dataschema: `https://aas.plant.local/integrations/schemas/${EVENT_TYPES.equipmentStateChanged}` });
    const next = await call('GET', `/integrations/events?after=${reply.body.nextAfter}`, { principal: VIEWER });
    expect(next.body.items.map((item: { data: { n: number } }) => item.data.n)).toEqual([3]);
    const empty = await call('GET', '/integrations/events?after=3', { principal: VIEWER });
    expect(empty.body).toMatchObject({ items: [], nextAfter: '3' });
  });

  it('filters by type (short or full name, prefix *) and package', async () => {
    const { store, call } = await feed();
    await store.appendEvents([event(1), event(2, EVENT_TYPES.equipmentAlarmRaised), event(3, EVENT_TYPES.equipmentStateChanged, 'pkg_2')]);
    const alarms = await call('GET', '/integrations/events?types=equipment.alarm.*', { principal: VIEWER });
    expect(alarms.body.items.map((item: { type: string }) => item.type)).toEqual([EVENT_TYPES.equipmentAlarmRaised]);
    const both = await call('GET', `/integrations/events?types=${EVENT_TYPES.equipmentAlarmRaised},equipment.state.changed.v1&packageId=pkg_1`, { principal: VIEWER });
    expect(both.body.items).toHaveLength(2);
  });

  it('Important: audit events only for admin sessions', async () => {
    const { store, call } = await feed();
    await store.appendEvents([event(1), event(2, EVENT_TYPES.integrationAudit)]);
    expect((await call('GET', '/integrations/events', { principal: VIEWER })).body.items).toHaveLength(1);
    expect((await call('GET', '/integrations/events')).body.items).toHaveLength(1);
    expect((await call('GET', '/integrations/events', { principal: ADMIN })).body.items).toHaveLength(2);
  });

  it.each(['after=-1', 'after=abc', 'limit=0', 'limit=1001', 'limit=1.5'])('400 for %s', async (query) => {
    const { call } = await feed();
    expect((await call('GET', `/integrations/events?${query}`, { principal: VIEWER })).status).toBe(400);
  });

  it('410 with oldestSeq when the cursor points into pruned history', async () => {
    const { store, time, call } = await feed();
    await store.appendEvents([event(1), event(2), event(3)]);
    time.advance(86_400_000);
    await store.appendEvents([event(4), event(5)]);
    await store.pruneEvents(new Date(time.now() - 3_600_000).toISOString());
    const gone = await call('GET', '/integrations/events?after=0', { principal: VIEWER });
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ code: 'Gone', oldestSeq: '4' });
    expect((await call('GET', '/integrations/events?after=3', { principal: VIEWER })).status).toBe(200);
  });

  it('a replay from the same cursor returns byte-identical messages', async () => {
    const { store, call, time } = await feed();
    await store.appendEvents([event(1), sampleRow(EVENT_TYPES.modelSubmodelUpdated) as unknown as ReturnType<typeof event>]);
    const first = await call('GET', '/integrations/events?after=0', { principal: VIEWER });
    time.advance(3_600_000);
    const again = await call('GET', '/integrations/events?after=0', { principal: VIEWER });
    expect(JSON.stringify(again.body.items)).toBe(JSON.stringify(first.body.items));
  });

  it('nextAfter moves past rows a filtered reader is not shown', async () => {
    const { store, call } = await feed();
    await store.appendEvents([event(1), event(2, EVENT_TYPES.equipmentAlarmRaised), event(3)]);
    const alarms = await call('GET', '/integrations/events?types=equipment.alarm.*', { principal: VIEWER });
    expect(alarms.body.items).toHaveLength(1);
    expect(alarms.body.nextAfter).toBe('3');
  });
});

describe('PostgreSQL (PGlite): settled on the unfiltered sequence — live E2E D5', () => {
  async function pgFeed() {
    const db = new PGlite();
    const store = new PostgresStore({
      async query(text, params) {
        return { rows: (await db.query(text, params as unknown[])).rows as never[] };
      },
    });
    await store.init();
    const call = routeCaller(store, { demo: false, services: testServices({ storeKind: 'postgres' }) });
    return { db, store, call };
  }

  it('repro 1: an audit row ahead of a model row does not hold back a reader who is not shown audit', async () => {
    const { store, call } = await pgFeed();
    await store.appendEvents([event(1, EVENT_TYPES.integrationAudit), event(2)]);
    const admin = await call('GET', '/integrations/events', { principal: ADMIN });
    expect(admin.body.items).toHaveLength(2);
    const viewer = await call('GET', '/integrations/events', { principal: VIEWER });
    expect(viewer.body.items.map((item: { data: { n: number } }) => item.data.n)).toEqual([2]);
    expect(viewer.body.nextAfter).toBe('2');
  });

  it('repro 2: a types-filtered reader gets committed rows at once', async () => {
    const { store, call } = await pgFeed();
    await store.appendEvents([event(1, EVENT_TYPES.modelShellUpdated), event(2), event(3, EVENT_TYPES.equipmentAlarmRaised)]);
    const reply = await call('GET', '/integrations/events?types=equipment.*', { principal: VIEWER });
    expect(reply.body.items).toHaveLength(2);
    expect(reply.body.nextAfter).toBe('3');
  });

  it('a real gap (rolled-back insert, next row young) still holds every reader', async () => {
    const { db, store, call } = await pgFeed();
    await store.appendEvents([event(1)]);
    await db.exec(`BEGIN; INSERT INTO integration_event (id, type, occurred_at, data) VALUES ('gone', '${EVENT_TYPES.equipmentStateChanged}', now(), '{}'::jsonb); ROLLBACK;`);
    await store.appendEvents([event(3)]);
    const reply = await call('GET', '/integrations/events', { principal: ADMIN });
    expect(reply.body.items).toHaveLength(1);
    expect(reply.body.nextAfter).toBe('1');
  });
});

describe('rendering (toCloudEvent)', () => {
  const ctx = { instanceId: '9f2c4e1a7b3d', publicBaseUrl: BASE };

  it('model events: subject is the package path, links.self is absolute, extensions from the row', () => {
    const rendered = toCloudEvent(sampleRow(EVENT_TYPES.modelSubmodelUpdated, 184223), ctx);
    const encoded = Buffer.from('https://example.com/ids/Submodel/1').toString('base64url');
    expect(rendered).toMatchObject({
      subject: `packages/pkg_12/submodels/${encoded}`,
      sequence: '00000000000000184223',
      vxpackageid: 'pkg_12',
      vxrevision: 37,
      vxcause: 'edit',
      vxchangeset: 'chg_5f1d0c2e5f1d0c2e',
      data: { links: { self: `https://aas.plant.local/packages/pkg_12/api/v3.0/submodels/${encoded}` } },
    });
  });

  it('package events: subject packages/<id>; runtime events: subject = raw globalAssetId; no dataschema without a public URL', () => {
    expect(toCloudEvent(sampleRow(EVENT_TYPES.modelPackageCreated), ctx).subject).toBe('packages/pkg_12');
    const runtime = toCloudEvent(sampleRow(EVENT_TYPES.equipmentStateChanged), { instanceId: 'x' });
    expect(runtime.subject).toBe('https://example.com/ids/asset/press-03');
    expect(runtime.dataschema).toBeUndefined();
    expect(runtime).not.toHaveProperty('vxrevision');
  });

  it('external-refs events are package events: subject packages/<id>, no links', () => {
    const rendered = toCloudEvent(sampleRow(EVENT_TYPES.modelExternalRefsUpdated), ctx);
    expect(rendered.subject).toBe('packages/pkg_12');
    expect(rendered.data).not.toHaveProperty('links');
  });

  it('links are path-only without AAS_PUBLIC_URL', () => {
    const rendered = toCloudEvent(sampleRow(EVENT_TYPES.modelShellCreated), { instanceId: 'x' });
    expect((rendered.data['links'] as { self: string }).self).toMatch(/^\/packages\/pkg_12\/api\/v3\.0\/shells\//);
  });
});

describe('schemas routes', () => {
  it('lists every type and serves one schema; unknown type 404', async () => {
    const { call } = await feed();
    const list = await call('GET', '/integrations/schemas', { principal: VIEWER });
    expect(list.body.types).toEqual([...ALL_EVENT_TYPES]);
    const one = await call('GET', `/integrations/schemas/${EVENT_TYPES.equipmentStateChanged}`, { principal: VIEWER });
    expect(one.status).toBe(200);
    expect(one.body.properties.type).toEqual({ const: EVENT_TYPES.equipmentStateChanged });
    expect((await call('GET', '/integrations/schemas/kr.vexplor.aas.nope.v1', { principal: VIEWER })).status).toBe(404);
  });
});

describe('change cause of a request (vxcause)', () => {
  it.each([
    ['POST', '/packages/:packageId/undo', 'undo'],
    ['POST', '/packages/:packageId/redo', 'redo'],
    ['POST', '/packages/:packageId/fix', 'fix'],
    ['POST', '/packages/:packageId/derivation/apply', 'derivation'],
    ['POST', '/packages', 'import'],
    ['POST', '/packages/new', 'import'],
    ['POST', '/packages/:packageId/clone', 'import'],
    ['PUT', '/packages/:packageId', 'import'],
    ['POST', '/bundles', 'import'],
    ['PUT', '/packages/:packageId/api/v3.0/submodels/:identifier', 'edit'],
    ['DELETE', '/packages/:packageId', 'edit'],
  ])('%s %s → %s', (method, pattern, cause) => {
    expect(causeOf(method, pattern)).toBe(cause);
  });
});

describe('error mapping', () => {
  it('ExternalRefConflictError → 409 with the claims', () => {
    const claims = [
      { system: 'sap-s4:PRD:100', type: 'equipment', id: '10000017', packageId: 'pkg_1', subject: 'asset|urn:a' },
      { system: 'sap-s4:PRD:100', type: 'equipment', id: '10000017', packageId: 'pkg_2', subject: 'asset|urn:b' },
    ];
    const response = toErrorResponse(new ExternalRefConflictError(claims));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ claims, messages: [{ code: 'ExternalRefConflict' }] });
  });
});
