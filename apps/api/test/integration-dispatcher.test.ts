/**
 * Dispatcher — fan-out, claim/lease, retry schedule, dead-letter, auto-disable, concurrency (design §5.2; MES C,
 * platform 7.2 / 7.3, CMMS T6–T7).
 *
 * The clock is injected; sends go through the real webhook sender to a local receiver, pinned to 127.0.0.1 (the
 * subscription host itself is public-looking — loopback is never allowed by the egress policy).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAasx } from '@aas/aasx';
import { EVENT_TYPES } from '@aas/core';
import { FolderStore, type NewEvent } from '@aas/store';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { Dispatcher, LEASE_MS } from '../src/integration/dispatcher.js';
import { newSigningSecret, SecretBox } from '../src/integration/secrets.js';
import { verifySignature } from '../src/integration/signing.js';
import { sendWebhook, type WebhookAttempt, type WebhookOutcome } from '../src/integration/webhook.js';
import type { IntegrationAasStore } from '../src/integration/deps.js';
import { clock, KEY, memoryStore, startReceiver, testServices } from './helpers/integration-scenarios.js';

const HOST = 'mes.example.com';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

let counter = 0;
const stateEvent = (patch: Partial<NewEvent> = {}): NewEvent => ({
  id: `evt_TEST${String(++counter).padStart(22, '0')}`,
  type: EVENT_TYPES.equipmentStateChanged,
  time: '2026-10-14T00:00:00.000Z',
  packageId: 'pkg_1',
  subject: 'https://example.com/asset/1',
  data: { state: 'run' },
  ...patch,
});

async function setup(options: {
  respond?: Parameters<typeof startReceiver>[0];
  send?: (attempt: WebhookAttempt) => Promise<WebhookOutcome>;
  random?: () => number;
  store?: IntegrationAasStore;
  time?: ReturnType<typeof clock>;
} = {}) {
  const time = options.time ?? clock();
  const store = options.store ?? (await memoryStore(time.iso));
  const receiver = await startReceiver(options.respond ?? (() => ({ status: 200 })));
  closers.push(receiver.close);
  const services = testServices({ allow: HOST, resolve: { [HOST]: ['93.184.216.34'] }, now: time.now });
  const box = services.secrets!;
  const dispatcher = new Dispatcher({
    store,
    instanceId: () => '9f2c4e1a7b3d',
    egress: services.egress,
    secrets: box,
    storeKind: 'memory',
    now: time.now,
    random: options.random ?? (() => 0.5),
    timeoutMs: 300,
    // Connect to the local receiver, report the address the egress check pinned (what a real send would show)
    send: options.send ?? (async (attempt) => ({ ...(await sendWebhook({ ...attempt, address: '127.0.0.1' }, time.now)), address: attempt.address })),
  });
  closers.push(() => dispatcher.stop(0));
  const subscribe = async (patch: { types?: string[]; packageIds?: string[]; enabled?: boolean } = {}) => {
    const secret = newSigningSecret();
    const subscription = await store.createSubscription({
      name: 'MES',
      kind: 'webhook',
      url: `http://${HOST}:${receiver.port}/hook`,
      types: patch.types ?? ['equipment.*'],
      packageIds: patch.packageIds ?? [],
      enabled: patch.enabled ?? true,
      options: {},
      secretHint: secret.slice(-4),
      secrets: { keyId: box.keyId, secretSealed: box.seal(secret) },
    });
    return { subscription, secret };
  };
  // First fan-out sets the cursor to "now" — history is not delivered to anyone
  await dispatcher.fanOut();
  return { store, time, receiver, dispatcher, subscribe, box };
}

const deliveries = async (store: IntegrationAasStore, subscriptionId: string) => (await store.listDeliveries(subscriptionId, { limit: 1000 })).items;

describe('fan-out', () => {
  it('delivers a matching event once, signed, as a CloudEvent', async () => {
    const { store, receiver, dispatcher, subscribe, time } = await setup();
    const { subscription, secret } = await subscribe();
    const [row] = await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect(receiver.requests).toHaveLength(1);
    const request = receiver.requests[0]!;
    expect(request.headers['webhook-id']).toBe(row!.id);
    expect(
      verifySignature({
        secrets: [secret],
        id: row!.id,
        timestamp: String(request.headers['webhook-timestamp']),
        signatureHeader: String(request.headers['webhook-signature']),
        body: request.body,
        nowSeconds: Math.floor(time.now() / 1000),
      }),
    ).toBe(true);
    const event = JSON.parse(request.body.toString());
    expect(event).toMatchObject({ specversion: '1.0', id: row!.id, source: 'urn:vexplor-aas:9f2c4e1a7b3d', sequence: String(row!.seq).padStart(20, '0') });
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 200, lastAddress: '93.184.216.34' });
    expect((await store.getSubscription(subscription.id))!.lastSuccessAt).toBe(time.iso());
    // Nothing more on a second pass
    await dispatcher.runOnce();
    expect(receiver.requests).toHaveLength(1);
  });

  it('filters by type, package, enabled, and never sends audit events', async () => {
    const { store, receiver, dispatcher, subscribe } = await setup();
    await subscribe({ types: ['equipment.alarm.*'] });
    await subscribe({ packageIds: ['pkg_2'] });
    await subscribe({ enabled: false });
    await store.appendEvents([
      stateEvent(),
      stateEvent({ type: EVENT_TYPES.equipmentAlarmRaised }),
      stateEvent({ packageId: 'pkg_2' }),
      stateEvent({ type: EVENT_TYPES.integrationAudit }),
    ]);
    await dispatcher.runOnce();
    const types = receiver.requests.map((request) => JSON.parse(request.body.toString()).type as string).sort();
    // alarm → subscription 1; pkg_2 state → subscription 2
    expect(types).toEqual([EVENT_TYPES.equipmentAlarmRaised, EVENT_TYPES.equipmentStateChanged]);
  });

  it('Important: a "*" subscription still never receives audit events (feed-only, admins)', async () => {
    const { store, receiver, dispatcher, subscribe } = await setup();
    await subscribe({ types: ['*'] });
    await store.appendEvents([stateEvent({ type: EVENT_TYPES.integrationAudit }), stateEvent()]);
    await dispatcher.runOnce();
    expect(receiver.requests.map((request) => JSON.parse(request.body.toString()).type)).toEqual([EVENT_TYPES.equipmentStateChanged]);
  });

  it('a new subscription does not get events recorded before it existed', async () => {
    const { store, receiver, dispatcher, subscribe, time } = await setup();
    await store.appendEvents([stateEvent()]);
    time.advance(1000);
    await subscribe();
    await dispatcher.runOnce();
    expect(receiver.requests).toHaveLength(0);
  });
});

describe('retries and dead-letter', () => {
  it('500 × 3 then 200: retried on the schedule (lower jitter bound), same webhook-id every time', async () => {
    const { store, receiver, dispatcher, subscribe, time } = await setup({ respond: (_r, index) => ({ status: index < 3 ? 500 : 200 }), random: () => 0 });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    const waits = [8_000, 48_000, 240_000];
    await dispatcher.runOnce();
    for (const wait of waits) {
      const [row] = await deliveries(store, subscription.id);
      expect(row).toMatchObject({ status: 'pending', lastStatusCode: 500 });
      expect(Date.parse(row!.nextAttemptAt) - time.now()).toBe(wait);
      time.advance(wait - 1);
      await dispatcher.runOnce();
      expect((await deliveries(store, subscription.id))[0]!.status).toBe('pending'); // not due yet
      time.advance(1);
      await dispatcher.runOnce();
    }
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'succeeded', attempts: 4 });
    expect(new Set(receiver.requests.map((request) => request.headers['webhook-id'])).size).toBe(1);
  });

  it('429 Retry-After longer than the schedule is honoured', async () => {
    const { store, dispatcher, subscribe, time } = await setup({ respond: () => ({ status: 429, headers: { 'retry-after': '70' } }) });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect(Date.parse((await deliveries(store, subscription.id))[0]!.nextAttemptAt) - time.now()).toBe(70_000);
  });

  it('other 4xx → dead at once, counted on the subscription', async () => {
    const { store, dispatcher, subscribe, receiver } = await setup({ respond: () => ({ status: 400 }) });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'dead', lastStatusCode: 400 });
    expect((await store.getSubscription(subscription.id))!.consecutiveDead).toBe(1);
    expect(receiver.requests).toHaveLength(1);
  });

  it('410 → dead and the subscription is disabled (never deleted)', async () => {
    const { store, dispatcher, subscribe } = await setup({ respond: () => ({ status: 410 }) });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect(await store.getSubscription(subscription.id)).toMatchObject({ enabled: false, disabledReason: '410 from receiver' });
  });

  it('12 failed attempts → dead', async () => {
    const { store, dispatcher, subscribe, time, receiver } = await setup({ respond: () => ({ status: 503 }) });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    for (let i = 0; i < 14; i++) {
      await dispatcher.runOnce();
      time.advance(10 * 3_600_000);
    }
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'dead', attempts: 12 });
    expect(receiver.requests).toHaveLength(12);
  });

  it('50 dead in a row and no success for 72 h → subscription disabled with a reason', async () => {
    const { store, dispatcher, subscribe, time } = await setup({ respond: () => ({ status: 404 }) });
    const { subscription } = await subscribe();
    await store.updateSubscription(subscription.id, { consecutiveDead: 49 });
    time.advance(73 * 3_600_000);
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    const after = (await store.getSubscription(subscription.id))!;
    expect(after.enabled).toBe(false);
    expect(after.consecutiveDead).toBe(50);
    expect(after.disabledReason).toMatch(/50 dead/);
  });

  it('50 dead in a row but a success within 72 h → stays enabled', async () => {
    const { store, dispatcher, subscribe } = await setup({ respond: () => ({ status: 404 }) });
    const { subscription } = await subscribe();
    await store.updateSubscription(subscription.id, { consecutiveDead: 49 });
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect(await store.getSubscription(subscription.id)).toMatchObject({ enabled: true, consecutiveDead: 50 });
  });

  it('a hanging receiver times out and the row is retried', async () => {
    const { store, dispatcher, subscribe } = await setup({ respond: () => 'hang' });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    const [row] = await deliveries(store, subscription.id);
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.lastError).toMatch(/timeout/);
  });

  it('a host that now resolves to a private address is refused at attempt time and retried', async () => {
    const time = clock();
    const store = await memoryStore(time.iso);
    const { dispatcher, subscribe } = await setup({ store, time });
    const { subscription } = await subscribe();
    await store.updateSubscription(subscription.id, { url: 'https://private.example.com/hook' });
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    const [row] = await deliveries(store, subscription.id);
    expect(row!.status).toBe('pending');
    expect(row!.lastError).toMatch(/^egress:/);
  });
});

describe('lease and crash safety', () => {
  it('Important: a row claimed by a process that died is sent again after the lease — with the same webhook-id', async () => {
    const { store, receiver, dispatcher, subscribe, time } = await setup();
    await subscribe();
    const [row] = await store.appendEvents([stateEvent()]);
    await dispatcher.fanOut();
    // Another process claims the row and dies before completeDelivery
    expect(await store.claimDeliveries(time.iso(), 10, LEASE_MS)).toHaveLength(1);
    await dispatcher.runOnce();
    expect(receiver.requests).toHaveLength(0);
    time.advance(LEASE_MS + 1);
    await dispatcher.runOnce();
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]!.headers['webhook-id']).toBe(row!.id);
  });

  /** A send that holds every request until released — lets the test see how many run at once */
  function heldSends() {
    const state = { active: 0, peak: 0, perUrl: new Map<string, number>(), peakPerUrl: 0, releases: [] as (() => void)[] };
    const send = async (attempt: WebhookAttempt): Promise<WebhookOutcome> => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      state.perUrl.set(attempt.url, (state.perUrl.get(attempt.url) ?? 0) + 1);
      state.peakPerUrl = Math.max(state.peakPerUrl, state.perUrl.get(attempt.url)!);
      await new Promise<void>((resolve) => state.releases.push(resolve));
      state.active--;
      state.perUrl.set(attempt.url, state.perUrl.get(attempt.url)! - 1);
      return { statusCode: 200, durationMs: 1, address: attempt.address, snippet: '' };
    };
    return { state, send };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('≤ 4 sends per subscription at once; claims stay bounded with 10 000 pending', async () => {
    const { state, send } = heldSends();
    const { store, dispatcher, subscribe } = await setup({ send });
    const claimSizes: number[] = [];
    const claim = store.claimDeliveries.bind(store);
    store.claimDeliveries = async (now, limit, leaseMs) => {
      claimSizes.push(limit);
      return claim(now, limit, leaseMs);
    };
    // (the claim takes only the subscription's free lanes — nothing waits in memory with a running lease)
    await subscribe();
    await store.appendEvents(Array.from({ length: 10_000 }, () => stateEvent()));
    let enqueued = 0;
    for (let batch = await dispatcher.fanOut(); batch > 0; batch = await dispatcher.fanOut()) enqueued += batch;
    expect(enqueued).toBe(10_000);
    expect(await dispatcher.claimAndStart()).toBe(4);
    await settle();
    expect(state.peak).toBe(4);
    expect(Math.max(...claimSizes)).toBeLessThanOrEqual(4);
    // The subscription's 4 lanes are busy — another claim takes nothing for it
    expect(await dispatcher.claimAndStart()).toBe(0);
    expect(Math.max(...claimSizes)).toBeLessThanOrEqual(4);
    while (state.releases.length > 0) state.releases.shift()!();
    await dispatcher.idle();
  });

  it('≤ 16 sends overall across subscriptions', async () => {
    const { state, send } = heldSends();
    const { store, dispatcher, subscribe } = await setup({ send });
    for (let i = 0; i < 6; i++) {
      const { subscription } = await subscribe();
      await store.updateSubscription(subscription.id, { url: `http://${HOST}:1000/sub${i}` });
    }
    await store.appendEvents(Array.from({ length: 20 }, () => stateEvent()));
    await dispatcher.fanOut();
    await dispatcher.claimAndStart();
    await settle();
    expect(state.peak).toBe(16);
    expect(state.peakPerUrl).toBeLessThanOrEqual(4);
    while (state.releases.length > 0) state.releases.shift()!();
    await dispatcher.idle();
  });
});

describe('rotation', () => {
  it('both secrets sign during the overlap, only the new one after it', async () => {
    const { store, receiver, dispatcher, subscribe, time, box } = await setup();
    const { subscription, secret: old } = await subscribe();
    const fresh = newSigningSecret();
    const current = (await store.getSubscription(subscription.id))!;
    await store.updateSubscription(subscription.id, {
      secrets: { ...current.secrets, secretSealed: box.seal(fresh), previousSealed: current.secrets.secretSealed, previousUntil: new Date(time.now() + 1000).toISOString() },
    });
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    expect(String(receiver.requests[0]!.headers['webhook-signature']).split(' ')).toHaveLength(2);
    time.advance(2000);
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    const late = receiver.requests[1]!;
    expect(String(late.headers['webhook-signature']).split(' ')).toHaveLength(1);
    const verify = (secrets: string[]) =>
      verifySignature({ secrets, id: String(late.headers['webhook-id']), timestamp: String(late.headers['webhook-timestamp']), signatureHeader: String(late.headers['webhook-signature']), body: late.body, nowSeconds: Math.floor(time.now() / 1000) });
    expect(verify([fresh])).toBe(true);
    expect(verify([old])).toBe(false);
  });
});

describe('test ping', () => {
  it('sends integration.ping.v1 signed like a real event and stores nothing', async () => {
    const { store, receiver, dispatcher, subscribe } = await setup({ respond: () => ({ status: 200, body: 'pong' }) });
    const { subscription } = await subscribe();
    const before = await store.readEvents({ after: 0, limit: 1000, includeAudit: true });
    const result = await dispatcher.testPing(subscription.id);
    expect(result).toMatchObject({ ok: true, statusCode: 200, responseSnippet: 'pong', address: '93.184.216.34' });
    expect(JSON.parse(receiver.requests[0]!.body.toString())).toMatchObject({ type: EVENT_TYPES.integrationPing, data: { subscriptionId: subscription.id } });
    expect((await store.readEvents({ after: 0, limit: 1000, includeAudit: true })).lastSeq).toBe(before.lastSeq);
    expect(await deliveries(store, subscription.id)).toEqual([]);
  });
});

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

describe('commit then crash (folder store, platform 7.2)', () => {
  it('a model change written by store A is delivered exactly once by a dispatcher on store B (reopened folder)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-crash-'));
    const a = new FolderStore(dir);
    await a.init();
    const box = new SecretBox(KEY);
    const secret = newSigningSecret();
    const receiver = await startReceiver(() => ({ status: 200 }));
    closers.push(receiver.close);
    await a.createSubscription({
      name: 'MES', kind: 'webhook', url: `http://${HOST}:${receiver.port}/hook`, types: ['model.*'], packageIds: [], enabled: true, options: {},
      secretHint: secret.slice(-4), secrets: { keyId: box.keyId, secretSealed: box.seal(secret) },
    });
    await a.putRuntimeState('dispatcher:cursor', 0);
    await a.importPackage({ name: '01.aasx', package: readAasx(goldenBytes) });
    // "crash": store A is abandoned without any further call; store B reopens the folder
    const b = new FolderStore(dir);
    await b.init();
    const services = testServices({ allow: HOST, resolve: { [HOST]: ['93.184.216.34'] } });
    const dispatcher = new Dispatcher({
      store: b, instanceId: () => '9f2c4e1a7b3d', egress: services.egress, secrets: box, storeKind: 'folder',
      send: (attempt) => sendWebhook({ ...attempt, address: '127.0.0.1' }),
    });
    await dispatcher.runOnce();
    await dispatcher.runOnce();
    const created = receiver.requests.filter((request) => JSON.parse(request.body.toString()).type === EVENT_TYPES.modelPackageCreated);
    expect(created).toHaveLength(1);
  });
});

// ── Security review (2026-10-14): lease, stale completion, fairness ───────────────────────────────────────────────

describe('security review — lease, stale completions, fairness', () => {
  it('item 1: the lease outlives the longest attempt; the timeout setting is clamped', async () => {
    const { leaseFor } = await import('../src/integration/dispatcher.js');
    const { timeoutFromEnv } = await import('../src/integration/boot.js');
    const { RESOLVE_TIMEOUT_MS } = await import('../src/integration/egress.js');
    const { MQTT_ATTEMPT_MS } = await import('../src/integration/transport.js');
    for (const timeout of [1_000, 10_000, 60_000]) {
      expect(leaseFor(timeout)).toBeGreaterThan(Math.max(timeout, MQTT_ATTEMPT_MS) + RESOLVE_TIMEOUT_MS);
    }
    expect(timeoutFromEnv({ INTEGRATION_TIMEOUT_MS: '500' })).toBe(1_000);
    expect(timeoutFromEnv({ INTEGRATION_TIMEOUT_MS: '999999' })).toBe(60_000);
    expect(timeoutFromEnv({ INTEGRATION_TIMEOUT_MS: '' })).toBe(10_000);
  });

  it('item 1: 16 rows through 4 lanes with slow sends — every row is sent exactly once', async () => {
    const sent: string[] = [];
    const releases: (() => void)[] = [];
    const send = (attempt: WebhookAttempt): Promise<WebhookOutcome> => {
      sent.push(attempt.headers['webhook-id']!);
      return new Promise((resolve) => releases.push(() => resolve({ statusCode: 200, durationMs: 1, address: attempt.address, snippet: '' })));
    };
    const { store, dispatcher, subscribe, time } = await setup({ send });
    await subscribe();
    await store.appendEvents(Array.from({ length: 16 }, () => stateEvent()));
    await dispatcher.fanOut();
    const flush = async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    // The review's sequence: every send takes 16 s; after 61 s the first claim's lease (60 s) has run out
    await dispatcher.claimAndStart();
    await flush();
    for (let round = 0; round < 3; round++) {
      time.advance(16_000);
      releases.splice(0).forEach((release) => release());
      await flush();
      await dispatcher.claimAndStart();
      await flush();
    }
    time.advance(13_000);
    await dispatcher.claimAndStart();
    await flush();
    for (let round = 0; round < 4; round++) {
      releases.splice(0).forEach((release) => release());
      await flush();
      time.advance(16_000);
      await dispatcher.claimAndStart();
      await flush();
    }
    await dispatcher.idle();
    expect(sent).toHaveLength(16);
    expect(new Set(sent).size).toBe(16);
  });

  it('item 1: a row whose lease ran out while it was still being sent is not sent a second time', async () => {
    const sent: string[] = [];
    const releases: (() => void)[] = [];
    const send = (attempt: WebhookAttempt): Promise<WebhookOutcome> => {
      sent.push(attempt.headers['webhook-id']!);
      return new Promise((resolve) => releases.push(() => resolve({ statusCode: 200, durationMs: 1, address: attempt.address, snippet: '' })));
    };
    const { store, dispatcher, subscribe, time } = await setup({ send });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.fanOut();
    await dispatcher.claimAndStart();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { leaseFor } = await import('../src/integration/dispatcher.js');
    time.advance(leaseFor(300) + 1);
    await dispatcher.claimAndStart();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    releases.splice(0).forEach((release) => release());
    await dispatcher.idle();
    // The completion carries the newer attempt number, so a guarding store still applies it
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('item 2: a completion the store did not apply changes no subscription counter', async () => {
    const time = clock();
    const store = await memoryStore(time.iso);
    // The store answers "not applied" — what a guarded store says to an overtaken attempt
    store.completeDelivery = (async () => false) as unknown as typeof store.completeDelivery;
    const { dispatcher, subscribe } = await setup({ store, time, respond: (_r, index) => ({ status: index === 0 ? 200 : 400 }) });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.runOnce();
    const after = (await store.getSubscription(subscription.id))!;
    expect(after.lastSuccessAt).toBeUndefined();
    await store.appendEvents([stateEvent()]);
    await dispatcher.fanOut();
    await dispatcher.claimAndStart();
    await dispatcher.idle();
    expect((await store.getSubscription(subscription.id))!.consecutiveDead).toBe(0);
  });

  it('item 2: a late result of this process does not overwrite another process that re-claimed the row', async () => {
    const releases: (() => void)[] = [];
    const send = (attempt: WebhookAttempt): Promise<WebhookOutcome> =>
      new Promise((resolve) => releases.push(() => resolve({ statusCode: 500, durationMs: 1, address: attempt.address, snippet: '' })));
    const { store, dispatcher, subscribe, time } = await setup({ send });
    const { subscription } = await subscribe();
    await store.appendEvents([stateEvent()]);
    await dispatcher.fanOut();
    await dispatcher.claimAndStart();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { leaseFor } = await import('../src/integration/dispatcher.js');
    time.advance(leaseFor(300) + 1);
    // Another process takes the expired row and is still sending it
    const [other] = await store.claimDeliveries(time.iso(), 1, 60_000);
    expect(other!.attempts).toBe(2);
    releases.splice(0).forEach((release) => release());
    await dispatcher.idle();
    expect((await deliveries(store, subscription.id))[0]).toMatchObject({ status: 'in-flight', attempts: 2 });
  });

  it('item 2 (store): a stale completion does not overwrite a newer outcome', async () => {
    const time = clock();
    const store = await memoryStore(time.iso);
    const { subscribe } = await setup({ store, time });
    const { subscription } = await subscribe();
    await store.enqueueDeliveries([{ subscriptionId: subscription.id, eventSeq: 1, eventId: 'e1' }], time.iso());
    const [first] = await store.claimDeliveries(time.iso(), 1, 60_000);
    time.advance(61_000);
    const [second] = await store.claimDeliveries(time.iso(), 1, 60_000);
    const complete = store.completeDelivery.bind(store) as (id: string, r: object) => Promise<boolean | void>;
    expect(await complete(second!.id, { outcome: 'succeeded', at: time.iso(), attempt: second!.attempts })).toBe(true);
    expect(await complete(first!.id, { outcome: 'retry', at: time.iso(), attempt: first!.attempts })).toBe(false);
    expect((await store.getDelivery(first!.id))!.status).toBe('succeeded');
  });

  it('item 4: one slow receiver with a backlog does not starve a healthy subscription', async () => {
    const bySub: Record<string, number> = {};
    const send = (attempt: WebhookAttempt): Promise<WebhookOutcome> => {
      const which = attempt.url.endsWith('/slow') ? 'slow' : 'healthy';
      bySub[which] = (bySub[which] ?? 0) + 1;
      if (which === 'slow') return new Promise(() => undefined); // a black hole
      return Promise.resolve({ statusCode: 200, durationMs: 1, address: attempt.address, snippet: '' });
    };
    const { store, dispatcher, subscribe } = await setup({ send });
    const slow = (await subscribe()).subscription;
    await store.updateSubscription(slow.id, { url: `http://${HOST}:1000/slow` });
    await store.appendEvents(Array.from({ length: 40 }, () => stateEvent()));
    await dispatcher.fanOut();
    const healthy = (await subscribe()).subscription;
    await store.updateSubscription(healthy.id, { url: `http://${HOST}:1000/healthy` });
    await store.appendEvents([stateEvent()]);
    await dispatcher.fanOut();
    await dispatcher.claimAndStart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bySub['slow']).toBe(4);
    expect(bySub['healthy']).toBe(1);
  });
});
