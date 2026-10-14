/**
 * Security review of the delivery code (2026-10-14) — one regression test per finding that is not about the
 * dispatcher's claim / lease logic (those are in integration-dispatcher.test.ts). Each test failed before its fix.
 */
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVENT_TYPES } from '@aas/core';
import { parseBrokerUrl } from '@aas/fieldbus';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { judgeAttempt, RETRY_SCHEDULE_MS } from '../src/integration/delivery-policy.js';
import { checkTarget, egressPolicyFromEnv, pinnedLookup, RESOLVE_TIMEOUT_MS } from '../src/integration/egress.js';
import { MqttSink, type MqttSinkClient, type MqttSinkConnectOptions } from '../src/integration/mqtt-sink.js';
import { maskUrlQuery } from '../src/integration/route-helpers.js';
import { loadMasterKey, newSigningSecret, SecretBox } from '../src/integration/secrets.js';
import { Transport } from '../src/integration/transport.js';
import type { WebhookAttempt, WebhookOutcome } from '../src/integration/webhook.js';
import { ADMIN, clock, KEY, memoryStore, routeCaller, testServices } from './helpers/integration-scenarios.js';

const HOST = 'mes.example.com';
const PUBLIC = { [HOST]: ['93.184.216.34'], 'broker.example.com': ['93.184.216.40'], 'other.example.com': ['93.184.216.50'] };

async function admin() {
  const time = clock();
  const store = await memoryStore(time.iso);
  const services = testServices({ resolve: PUBLIC, now: time.now });
  const raw = routeCaller(store, { demo: false, services });
  const call = (method: string, path: string, body?: unknown) => raw(method, path, { principal: ADMIN, ...(body === undefined ? {} : { body }) });
  return { store, time, call, services };
}

describe('item 5 — MQTT credentials stay with the broker they were given for', () => {
  it('a URL change to another host clears them; the same broker keeps them; new ones in the URL replace them', async () => {
    const { call, store } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'B', kind: 'mqtt', url: 'mqtts://plant:s3cret@broker.example.com', types: ['equipment.*'] });
    const id = made.body.subscription.id;
    await call('PATCH', `/integrations/subscriptions/${id}`, { url: 'mqtts://broker.example.com:8883' });
    expect((await store.getSubscription(id))!.secrets.credentialsSealed).toBeDefined();
    const moved = await call('PATCH', `/integrations/subscriptions/${id}`, { url: 'mqtts://other.example.com' });
    expect(moved.status).toBe(200);
    expect((await store.getSubscription(id))!.secrets.credentialsSealed).toBeUndefined();
    await call('PATCH', `/integrations/subscriptions/${id}`, { url: 'mqtts://new:pw@other.example.com' });
    expect(new SecretBox(KEY).open((await store.getSubscription(id))!.secrets.credentialsSealed!)).toBe('new:pw');
  });

  it('a port or scheme change counts as another target', async () => {
    const { call, store } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'B', kind: 'mqtt', url: 'mqtts://plant:s3cret@broker.example.com', types: ['equipment.*'] });
    const id = made.body.subscription.id;
    await call('PATCH', `/integrations/subscriptions/${id}`, { url: 'mqtts://broker.example.com:9883' });
    expect((await store.getSubscription(id))!.secrets.credentialsSealed).toBeUndefined();
  });
});

describe('item 7 — no second rotation while the previous secret is still valid', () => {
  it('409 within 24 h, allowed after', async () => {
    const { call, time } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['equipment.*'] });
    const id = made.body.subscription.id;
    expect((await call('POST', `/integrations/subscriptions/${id}/rotate-secret`)).status).toBe(200);
    const again = await call('POST', `/integrations/subscriptions/${id}/rotate-secret`);
    expect(again.status).toBe(409);
    expect(again.body.messages[0].code).toBe('RotationInProgress');
    time.advance(24 * 3_600_000 + 1);
    expect((await call('POST', `/integrations/subscriptions/${id}/rotate-secret`)).status).toBe(200);
  });
});

describe('item 3 (route) — redeliver only finished rows', () => {
  it('pending and in-flight → 409; dead → 200', async () => {
    const { call, store, time } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['equipment.*'] });
    const id = made.body.subscription.id;
    await store.enqueueDeliveries([{ subscriptionId: id, eventSeq: 1, eventId: 'evt_1' }], time.iso());
    const [row] = (await store.listDeliveries(id)).items;
    expect((await call('POST', `/integrations/deliveries/${row!.id}/redeliver`)).status).toBe(409);
    await store.claimDeliveries(time.iso(), 1, 60_000);
    const busy = await call('POST', `/integrations/deliveries/${row!.id}/redeliver`);
    expect(busy.status).toBe(409);
    expect(busy.body.messages[0].code).toBe('DeliveryBusy');
    await store.completeDelivery(row!.id, { outcome: 'dead', at: time.iso() });
    expect((await call('POST', `/integrations/deliveries/${row!.id}/redeliver`)).status).toBe(200);
  });
});

describe('item 6 — PATCH with kind gets a clear 400', () => {
  it('names kind and says what to do', async () => {
    const { call } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['equipment.*'] });
    const reply = await call('PATCH', `/integrations/subscriptions/${made.body.subscription.id}`, { kind: 'webhook', name: 'x' });
    expect(reply.status).toBe(400);
    expect(reply.body.messages[0].text).toContain('kind');
    expect(reply.body.messages[0].text).toContain('새 구독');
  });
});

describe('(a) query strings are masked in audit details', () => {
  it('?token=… never reaches the audit log; the subscription GET still shows the full URL to the admin', async () => {
    const { call, store } = await admin();
    const url = `https://${HOST}/hook?token=SUPERSECRET&x=1&bare`;
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url, types: ['equipment.*'] });
    const id = made.body.subscription.id;
    await call('PATCH', `/integrations/subscriptions/${id}`, { name: 'renamed' });
    expect((await call('GET', `/integrations/subscriptions/${id}`)).body.url).toBe(url);
    await call('DELETE', `/integrations/subscriptions/${id}`);
    const audit = JSON.stringify((await store.readEvents({ after: 0, limit: 100, includeAudit: true })).items.filter((row) => row.type === EVENT_TYPES.integrationAudit));
    expect(audit).not.toContain('SUPERSECRET');
    expect(audit).toContain('token=***');
    expect(maskUrlQuery(url)).toBe(`https://${HOST}/hook?token=***&x=***&***`);
    expect(maskUrlQuery(`https://${HOST}/hook`)).toBe(`https://${HOST}/hook`);
  });
});

describe('(b) Retry-After can only lengthen the wait', () => {
  it('Retry-After: 0 keeps the schedule; a long one is capped at 1 h but never shortens the schedule', () => {
    const half = () => 0.5;
    expect(judgeAttempt({ attempts: 1, statusCode: 429, retryAfterMs: 0 }, half)).toEqual({ outcome: 'retry', delayMs: RETRY_SCHEDULE_MS[1] });
    expect(judgeAttempt({ attempts: 1, statusCode: 429, retryAfterMs: 99_999_000 }, half)).toEqual({ outcome: 'retry', delayMs: 3_600_000 });
    expect(judgeAttempt({ attempts: 10, statusCode: 503, retryAfterMs: 99_999_000 }, half)).toEqual({ outcome: 'retry', delayMs: RETRY_SCHEDULE_MS[10] });
  });
});

describe('(c) subscription responses are not cached', () => {
  it('create, rotate, list and errors carry Cache-Control: no-store', async () => {
    const { call } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['equipment.*'] });
    expect(made.headers['cache-control']).toBe('no-store');
    const id = made.body.subscription.id;
    expect((await call('POST', `/integrations/subscriptions/${id}/rotate-secret`)).headers['cache-control']).toBe('no-store');
    expect((await call('GET', '/integrations/subscriptions')).headers['cache-control']).toBe('no-store');
    expect((await call('POST', '/integrations/subscriptions', { name: 'x', kind: 'webhook', url: 'https://169.254.169.254/', types: ['*'] })).headers['cache-control']).toBe('no-store');
  });
});

describe('item 8 — MQTT connects to the port the egress check judged', () => {
  it('mqtts://host:443 and mqtt://host:80 keep their ports', () => {
    expect(parseBrokerUrl('mqtts://broker.example.com:443')).toEqual({ host: 'broker.example.com', port: 443, tls: true });
    expect(parseBrokerUrl('mqtt://broker.example.com:80')).toEqual({ host: 'broker.example.com', port: 80, tls: false });
    expect(parseBrokerUrl('mqtts://broker.example.com')).toMatchObject({ port: 8883 });
    expect(parseBrokerUrl('mqtt://[::1]:1884')).toEqual({ host: '::1', port: 1884, tls: false });
  });

  it('the transport hands host, port and TLS from the egress check to the client', async () => {
    const seen: MqttSinkConnectOptions[] = [];
    const sink = new MqttSink(async (options) => {
      seen.push(options);
      return { connected: true, publish: async () => undefined, close: async () => undefined };
    }, () => 'x');
    const services = testServices({ resolve: PUBLIC });
    const transport = new Transport({ egress: services.egress, secrets: services.secrets, mqtt: sink, instanceId: () => 'x', now: Date.now });
    const box = services.secrets!;
    const result = await transport.ping({
      id: 'sub_1', name: 'B', kind: 'mqtt', url: 'mqtts://broker.example.com:443', types: ['*'], packageIds: [], enabled: true, options: {}, secretHint: 'x',
      consecutiveDead: 0, createdAt: '', updatedAt: '', secrets: { keyId: box.keyId, secretSealed: box.seal('whsec_x') },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.target).toEqual({ host: 'broker.example.com', port: 443, tls: true });
  });
});

describe('item 9 — concurrent first deliveries share one MQTT connection', () => {
  it('four at once → one connect, one close', async () => {
    let connects = 0;
    let closes = 0;
    const sink = new MqttSink(async (): Promise<MqttSinkClient> => {
      connects++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { connected: true, publish: async () => undefined, close: async () => void closes++ };
    }, () => 'x');
    const target = { subscriptionId: 'sub_1', url: 'mqtts://b.example.com', lookup: pinnedLookup('93.184.216.34'), servername: 'b.example.com' };
    const event = { specversion: '1.0', id: 'evt_1', source: 'x', type: EVENT_TYPES.equipmentStateChanged, time: 't', datacontenttype: 'application/json', sequence: '1', data: {} } as const;
    await Promise.all([1, 2, 3, 4].map(() => sink.deliver(target, { ...event }, Buffer.from('{}'))));
    await sink.close();
    expect(connects).toBe(1);
    expect(closes).toBe(1);
  });
});

describe('item 10 — a DNS lookup that never answers fails after 5 s', () => {
  afterEach(() => vi.useRealTimers());
  it('clear failure instead of a hung lane', async () => {
    vi.useFakeTimers();
    const policy = egressPolicyFromEnv({}, false, () => new Promise<string[]>(() => undefined));
    const pending = checkTarget('https://slow.example.com/', 'webhook', policy);
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/timed out/);
  });
});

describe('item 11 — special-purpose ranges', () => {
  const policy = egressPolicyFromEnv({}, false, async (host) => (host === 'localhost.' ? ['127.0.0.1'] : ['93.184.216.34']));
  it.each([
    'https://[64:ff9b:1::a9fe:a9fe]/',
    'https://[64:ff9b:1:7f00:0:100::]/',
    'https://[::ffff:0:a9fe:a9fe]/',
    'https://192.0.0.192/',
    'https://198.18.0.1/',
    'https://192.0.2.10/',
    'https://[2001:db8::1]/',
    'https://localhost./',
  ])('%s is refused', async (url) => {
    expect((await checkTarget(url, 'webhook', policy)).ok).toBe(false);
  });

  it('a special range opens only when the allowlist names it (loopback inside never does)', async () => {
    const allowed = egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: '198.18.0.0/15,64:ff9b:1::/48' }, false);
    expect((await checkTarget('https://198.18.0.1/', 'webhook', allowed)).ok).toBe(true);
    expect((await checkTarget('https://[64:ff9b:1::7f00:1]/', 'webhook', allowed)).ok).toBe(false);
  });
});

describe('item 12 — reference receiver limits', () => {
  type Receiver = { createReceiver: (options: Record<string, unknown>) => Parameters<typeof createServer>[1] };
  const load = async (): Promise<Receiver> => (await import(new URL('../../../examples/webhook-receiver.mjs', import.meta.url).href)) as Receiver;
  const secret = newSigningSecret();

  async function serve(options: Record<string, unknown>) {
    const { createReceiver } = await load();
    const server = createServer(createReceiver({ secrets: [secret], ...options }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('413 for a body over the cap, 400 for a body that is not JSON (validly signed)', async () => {
    const { signatureHeaders } = await import('../src/integration/signing.js');
    const { port, close } = await serve({ maxBodyBytes: 100 });
    try {
      const big = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(1000) }).catch(() => undefined);
      if (big) expect(big.status).toBe(413);
      const body = Buffer.from('not json');
      const ts = Math.floor(Date.now() / 1000);
      const headers = signatureHeaders([secret], 'evt_1', ts, body);
      const reply = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers, body });
      expect(reply.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('the dedupe memory is bounded', async () => {
    const { signatureHeaders } = await import('../src/integration/signing.js');
    const { port, close } = await serve({ maxRemembered: 3 });
    try {
      const body = Buffer.from('{}');
      const ts = Math.floor(Date.now() / 1000);
      const send = (id: string) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: signatureHeaders([secret], id, ts, body), body });
      for (const id of ['a', 'b', 'c', 'd', 'e']) expect((await send(id)).status).toBe(204);
      // 'e' is still remembered; 'a' had to make room
      expect((await send('e')).status).toBe(200);
      expect((await send('a')).status).toBe(204);
    } finally {
      await close();
    }
  });
});

describe('item 13 — secret.key permissions', () => {
  it.skipIf(process.platform === 'win32')('an existing key file readable by others is tightened to 0600, with a warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-key-'));
    const file = join(dir, 'secret.key');
    writeFileSync(file, KEY.toString('base64') + '\n');
    chmodSync(file, 0o644);
    const key = loadMasterKey({ env: {}, storeKind: 'folder', dataDir: dir });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(key.warning).toContain('0600');
    expect(key.box!.keyId).toBe(new SecretBox(KEY).keyId);
  });
});

describe('item 14 — a previous secret sealed with an old master key', () => {
  it('is skipped: delivery signs with the current secret; status names the mismatch', async () => {
    const services = testServices({ resolve: PUBLIC });
    const box = services.secrets!;
    const oldBox = new SecretBox(Buffer.alloc(32, 1));
    const sends: WebhookAttempt[] = [];
    const transport = new Transport({
      egress: services.egress, secrets: box, instanceId: () => 'x', now: Date.now,
      send: async (attempt): Promise<WebhookOutcome> => {
        sends.push(attempt);
        return { statusCode: 200, durationMs: 1, address: attempt.address, snippet: '' };
      },
    });
    const result = await transport.ping({
      id: 'sub_1', name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['*'], packageIds: [], enabled: true, options: {}, secretHint: 'x',
      consecutiveDead: 0, createdAt: '', updatedAt: '',
      secrets: { keyId: box.keyId, secretSealed: box.seal(newSigningSecret()), previousSealed: oldBox.seal(newSigningSecret()), previousUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(result.ok).toBe(true);
    expect(sends[0]!.headers['webhook-signature']!.split(' ')).toHaveLength(1);

    const { call, store } = await admin();
    const made = await call('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `https://${HOST}/h`, types: ['*'] });
    const full = (await store.getSubscription(made.body.subscription.id))!;
    await store.updateSubscription(full.id, { secrets: { ...full.secrets, keyId: oldBox.keyId, secretSealed: oldBox.seal('whsec_x') } });
    expect((await call('GET', '/integrations/status')).body.masterKeyMismatch).toEqual([full.id]);
  });
});

