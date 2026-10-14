/**
 * Subscription management routes (design §4.2): create / list / get / patch / delete, rotate, test, replay,
 * deliveries, redeliver, status. Route level with an admin principal — permissions are in integration-permissions.
 */
import { EVENT_TYPES } from '@aas/core';
import { describe, expect, it } from 'vitest';

import type { IntegrationRuntimeDeps } from '../src/integration/deps.js';
import { SecretBox } from '../src/integration/secrets.js';
import { ADMIN, clock, KEY, memoryStore, routeCaller, testServices } from './helpers/integration-scenarios.js';

const PUBLIC = { 'mes.example.com': ['93.184.216.34'], 'broker.example.com': ['93.184.216.40'] };

async function admin(options: { runtime?: IntegrationRuntimeDeps; secrets?: SecretBox | undefined } = {}) {
  const time = clock();
  const store = await memoryStore(time.iso);
  const services = testServices({ resolve: PUBLIC, allow: '10.20.0.0/16', now: time.now, ...('secrets' in options ? { secrets: options.secrets } : {}) });
  const raw = routeCaller(store, { demo: false, services, ...(options.runtime ? { runtime: options.runtime } : {}) });
  const call = (method: string, path: string, body?: unknown) => raw(method, path, { principal: ADMIN, ...(body === undefined ? {} : { body }) });
  return { store, time, call, services };
}

const WEBHOOK = { name: 'MES Changwon', kind: 'webhook', url: 'https://mes.example.com/hook', types: ['equipment.*'] };

describe('create', () => {
  it('201 with the secret shown once; the record carries only the hint', async () => {
    const { call, store } = await admin();
    const reply = await call('POST', '/integrations/subscriptions', WEBHOOK);
    expect(reply.status).toBe(201);
    const { subscription, secret } = reply.body;
    expect(secret).toMatch(/^whsec_/);
    expect(subscription).toMatchObject({ name: 'MES Changwon', kind: 'webhook', enabled: true, packageIds: [], secretHint: secret.slice(-4), createdBy: ADMIN.userId });
    expect(JSON.stringify(subscription)).not.toContain(secret);
    const stored = (await store.getSubscription(subscription.id))!;
    expect(new SecretBox(KEY).open(stored.secrets.secretSealed)).toBe(secret);
  });

  it.each([
    ['missing types', { ...WEBHOOK, types: undefined }],
    ['empty types', { ...WEBHOOK, types: [] }],
    ['unknown type', { ...WEBHOOK, types: ['equipment.nope.v1'] }],
    ['audit is not deliverable', { ...WEBHOOK, types: ['integration.audit.v1'] }],
    ['bad kind', { ...WEBHOOK, kind: 'smtp' }],
    ['unknown field', { ...WEBHOOK, packageID: ['pkg_1'] }],
    ['wildcard in topic prefix', { ...WEBHOOK, options: { topicPrefix: 'a/#' } }],
    ['userinfo on webhook', { ...WEBHOOK, url: 'https://u:p@mes.example.com/hook' }],
    ['not an object', [1, 2]],
  ])('400 for %s', async (_name, body) => {
    const { call } = await admin();
    expect((await call('POST', '/integrations/subscriptions', body)).status).toBe(400);
  });

  it('422 TargetNotAllowed with the reason (egress policy)', async () => {
    const { call } = await admin();
    const reply = await call('POST', '/integrations/subscriptions', { ...WEBHOOK, url: 'https://169.254.169.254/' });
    expect(reply.status).toBe(422);
    expect(reply.body.code).toBe('TargetNotAllowed');
    expect(reply.body.reason).toContain('169.254.169.254');
  });

  it('503 MasterKeyMissing without a master key', async () => {
    const { call } = await admin({ secrets: undefined });
    const reply = await call('POST', '/integrations/subscriptions', WEBHOOK);
    expect(reply.status).toBe(503);
    expect(reply.body.messages[0].code).toBe('MasterKeyMissing');
  });

  it('MQTT credentials are stripped from the URL and sealed separately', async () => {
    const { call, store } = await admin();
    const reply = await call('POST', '/integrations/subscriptions', {
      name: 'Broker', kind: 'mqtt', url: 'mqtts://plant:s%40cret@broker.example.com:8883', types: ['*'], options: { topicPrefix: 'plant/aas', retainState: true },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.subscription.url).toBe('mqtts://broker.example.com:8883');
    const stored = (await store.getSubscription(reply.body.subscription.id))!;
    expect(new SecretBox(KEY).open(stored.secrets.credentialsSealed!)).toBe('plant:s@cret');
    const events = await store.readEvents({ after: 0, limit: 100, includeAudit: true });
    expect(JSON.stringify(events)).not.toContain('s@cret');
    expect(JSON.stringify(events)).not.toContain('s%40cret');
  });
});

describe('read, patch, delete', () => {
  it('lists with delivery stats, gets one without secrets', async () => {
    const { call } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const list = await call('GET', '/integrations/subscriptions');
    expect(list.body.items[0]).toMatchObject({ id: subscription.id, stats: { pending: 0, dead: 0 } });
    const one = await call('GET', `/integrations/subscriptions/${subscription.id}`);
    expect(one.body).not.toHaveProperty('secrets');
    expect((await call('GET', '/integrations/subscriptions/nope')).status).toBe(404);
  });

  it('PATCH re-checks the URL (422) and enabling clears the disable reason and the dead count', async () => {
    const { call, store } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    expect((await call('PATCH', `/integrations/subscriptions/${subscription.id}`, { url: 'https://10.99.0.1/hook' })).status).toBe(422);
    expect((await call('PATCH', `/integrations/subscriptions/${subscription.id}`, { url: 'http://10.20.0.9:8080/hook' })).status).toBe(200);
    await store.updateSubscription(subscription.id, { enabled: false, disabledReason: '410 from receiver', consecutiveDead: 7 });
    const enabled = await call('PATCH', `/integrations/subscriptions/${subscription.id}`, { enabled: true });
    expect(enabled.body).toMatchObject({ enabled: true, consecutiveDead: 0 });
    expect(enabled.body).not.toHaveProperty('disabledReason');
    expect((await call('PATCH', `/integrations/subscriptions/${subscription.id}`, { kind: 'mqtt' })).status).toBe(400);
  });

  it('DELETE 204, then 404; deliveries cascade', async () => {
    const { call, store, time } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    await store.enqueueDeliveries([{ subscriptionId: subscription.id, eventSeq: 1, eventId: 'evt_1' }], time.iso());
    expect((await call('DELETE', `/integrations/subscriptions/${subscription.id}`)).status).toBe(204);
    expect((await call('DELETE', `/integrations/subscriptions/${subscription.id}`)).status).toBe(404);
    expect((await store.deliveryStats()).find((entry) => entry.subscriptionId === subscription.id)).toBeUndefined();
  });

  it('every change writes an audit event without secrets', async () => {
    const { call, store } = await admin();
    const created = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const id = created.subscription.id;
    await call('PATCH', `/integrations/subscriptions/${id}`, { name: 'Renamed' });
    const rotated = (await call('POST', `/integrations/subscriptions/${id}/rotate-secret`)).body;
    await call('DELETE', `/integrations/subscriptions/${id}`);
    const audit = (await store.readEvents({ after: 0, limit: 100, includeAudit: true })).items.filter((row) => row.type === EVENT_TYPES.integrationAudit);
    expect(audit.map((row) => row.data['action'])).toEqual(['subscription.created', 'subscription.updated', 'subscription.secret-rotated', 'subscription.deleted']);
    expect(audit[0]).toMatchObject({ actorId: ADMIN.userId, actorName: ADMIN.displayName, data: { target: id, actor: { id: ADMIN.userId } } });
    const text = JSON.stringify(audit);
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain(rotated.secret);
  });
});

describe('rotate, test, replay, deliveries, redeliver, status', () => {
  it('rotate returns a new secret once; the old one stays valid for 24 h', async () => {
    const { call, store, time } = await admin();
    const created = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const reply = await call('POST', `/integrations/subscriptions/${created.subscription.id}/rotate-secret`);
    expect(reply.body.secret).not.toBe(created.secret);
    expect(Date.parse(reply.body.previousValidUntil) - time.now()).toBe(24 * 3_600_000);
    const stored = (await store.getSubscription(created.subscription.id))!;
    const box = new SecretBox(KEY);
    expect(box.open(stored.secrets.secretSealed)).toBe(reply.body.secret);
    expect(box.open(stored.secrets.previousSealed!)).toBe(created.secret);
    expect(stored.secretHint).toBe(reply.body.secret.slice(-4));
  });

  it('test answers 503 IntegrationsOff without workers, and the worker result with them', async () => {
    const off = await admin();
    const { subscription } = (await off.call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const reply = await off.call('POST', `/integrations/subscriptions/${subscription.id}/test`);
    expect(reply.status).toBe(503);
    expect(reply.body.messages[0].code).toBe('IntegrationsOff');

    const result = { ok: true as const, statusCode: 200, durationMs: 41, address: '93.184.216.34', responseSnippet: 'ok', serverTime: 'now' };
    const on = await admin({ runtime: { status: () => ({ enabled: true, running: ['dispatcher'] }), testSubscription: async () => result } });
    const created = (await on.call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    expect((await on.call('POST', `/integrations/subscriptions/${created.subscription.id}/test`)).body).toEqual(result);
  });

  it('replay from a seq or a time enqueues matching events; a second replay re-sets finished rows to pending', async () => {
    const { call, store, time } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const events = await store.appendEvents(
      [1, 2, 3, 4].map((n) => ({ id: `evt_${n}`, type: n === 3 ? EVENT_TYPES.modelShellCreated : EVENT_TYPES.equipmentStateChanged, time: time.iso(), packageId: 'pkg_1', data: {} })),
    );
    const first = await call('POST', `/integrations/subscriptions/${subscription.id}/replay`, { fromSeq: String(events[1]!.seq) });
    expect(first.body).toEqual({ enqueued: 2 }); // seq 2 and 4 — seq 3 is a model event, not subscribed
    const [claimed] = await store.claimDeliveries(time.iso(), 1, 60_000);
    await store.completeDelivery(claimed!.id, { outcome: 'succeeded', at: time.iso() });
    const again = await call('POST', `/integrations/subscriptions/${subscription.id}/replay`, { from: '2026-10-13T00:00:00Z' });
    expect(again.body).toEqual({ enqueued: 2 }); // seq 1 new, the succeeded row back to pending; the pending one untouched
    expect((await store.listDeliveries(subscription.id, { status: 'pending' })).items).toHaveLength(3);
    expect((await call('POST', `/integrations/subscriptions/${subscription.id}/replay`, {})).status).toBe(400);
    expect((await call('POST', `/integrations/subscriptions/${subscription.id}/replay`, { fromSeq: '1', from: 'x' })).status).toBe(400);
  });

  it('deliveries list carries the event type; redeliver resets a row and 404s an unknown one', async () => {
    const { call, store, time } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    const [row] = await store.appendEvents([{ id: 'evt_x', type: EVENT_TYPES.equipmentAlarmRaised, time: time.iso(), packageId: 'pkg_1', data: {} }]);
    await store.enqueueDeliveries([{ subscriptionId: subscription.id, eventSeq: row!.seq, eventId: row!.id }], time.iso());
    const [claimed] = await store.claimDeliveries(time.iso(), 1, 60_000);
    await store.completeDelivery(claimed!.id, { outcome: 'dead', at: time.iso(), statusCode: 400 });
    const list = await call('GET', `/integrations/subscriptions/${subscription.id}/deliveries?status=dead`);
    expect(list.body.items[0]).toMatchObject({ id: claimed!.id, status: 'dead', type: EVENT_TYPES.equipmentAlarmRaised });
    expect((await call('GET', `/integrations/subscriptions/${subscription.id}/deliveries?status=lost`)).status).toBe(400);
    expect((await call('GET', `/integrations/subscriptions/${subscription.id}/deliveries?limit=201`)).status).toBe(400);
    const redone = await call('POST', `/integrations/deliveries/${claimed!.id}/redeliver`);
    expect(redone.body).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await call('POST', '/integrations/deliveries/999/redeliver')).status).toBe(404);
  });

  it('status reports enablement, backlog, egress, master key, instance id', async () => {
    const { call, store, time } = await admin();
    const { subscription } = (await call('POST', '/integrations/subscriptions', WEBHOOK)).body;
    await store.enqueueDeliveries([{ subscriptionId: subscription.id, eventSeq: 1, eventId: 'evt_1' }], time.iso());
    const reply = await call('GET', '/integrations/status');
    expect(reply.body).toMatchObject({
      enabled: false,
      demo: false,
      instanceId: '9f2c4e1a7b3d',
      backlog: { pending: 1, oldestPendingAt: time.iso(), dead: 0 },
      egress: { allow: ['10.20.0.0/16'] },
      masterKey: 'env',
      opcua: { security: 'off' },
    });
    expect(reply.body.egress.blockedPorts).toContain(6379);
  });
});
