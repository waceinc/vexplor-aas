/**
 * Boot / lifecycle of the integration subsystem (design §5.1, D15) and the end-to-end path (platform 7.8):
 * upload → edit a submodel over Part 2 → undo, seen by the pull feed and by a webhook receiver, in revision order.
 *
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpServer, integrationsOf } from '@aas/api';
import { readAasx } from '@aas/aasx';
import { EVENT_TYPES } from '@aas/core';
import { FolderStore, InMemoryStore, type AasStore } from '@aas/store';
import { afterEach, describe, expect, it } from 'vitest';

import { startIntegrations } from '../src/integration/boot.js';
import { hashPassword } from '../src/password.js';
import { verifySignature } from '../src/integration/signing.js';
import { sendWebhook } from '../src/integration/webhook.js';
import { clock, KEY, memoryStore, startReceiver } from './helpers/integration-scenarios.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

describe('startIntegrations', () => {
  it('off by default: no workers, services present, the reason is stated', async () => {
    const boot = startIntegrations({ store: await memoryStore(), env: {}, demo: false, storeKind: 'memory' });
    closers.push(() => boot.stop());
    expect(boot.enabled).toBe(false);
    // runtime is present (status, OPC UA trust store) but has no worker members
    expect(boot.runtimeDeps.testSubscription).toBeUndefined();
    expect(boot.runtimeDeps.wakeDispatcher).toBeUndefined();
    expect(boot.onPackageCycle).toBeUndefined();
    expect(boot.status()).toMatchObject({ enabled: false, running: [] });
    expect(boot.status().reason).toContain('INTEGRATIONS=on');
    expect(boot.services.masterKey).toBe('ephemeral');
  });

  it('demo mode forces it off even with INTEGRATIONS=on', async () => {
    const boot = startIntegrations({ store: await memoryStore(), env: { INTEGRATIONS: 'on' }, demo: true, storeKind: 'memory' });
    closers.push(() => boot.stop());
    expect(boot.enabled).toBe(false);
    expect(boot.status().reason).toContain('DEMO_MODE');
    expect(boot.services.egress.demo).toBe(true);
  });

  it('INTEGRATIONS=on starts the dispatcher and exposes the runtime members', async () => {
    const boot = startIntegrations({ store: await memoryStore(), env: { INTEGRATIONS: 'on' }, demo: false, storeKind: 'memory' });
    closers.push(() => boot.stop());
    expect(boot.enabled).toBe(true);
    expect(boot.status().running).toContain('dispatcher');
    expect(boot.runtimeDeps?.wakeDispatcher).toBeTypeOf('function');
    expect(boot.runtimeDeps?.testSubscription).toBeTypeOf('function');
    await boot.stop();
    expect(boot.status().running).toEqual([]);
  });

  it('a store without the integration port stays off and says so', () => {
    const bare = { init: async () => undefined } as unknown as AasStore;
    const boot = startIntegrations({ store: bare, env: { INTEGRATIONS: 'on' }, demo: false, storeKind: 'memory' });
    expect(boot.enabled).toBe(false);
    expect(boot.status().reason).toBeTruthy();
  });

  it('the instance id is created once and kept in the store', async () => {
    const store = await memoryStore();
    const first = await startIntegrations({ store, env: {}, demo: false, storeKind: 'memory' }).services.instanceId();
    const second = await startIntegrations({ store, env: {}, demo: false, storeKind: 'memory' }).services.instanceId();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  it('prunes events beyond INTEGRATION_RETENTION_DAYS at start (and hourly)', async () => {
    const time = clock();
    const store = await memoryStore(time.iso);
    await store.appendEvents([{ id: 'evt_old', type: EVENT_TYPES.equipmentStateChanged, time: time.iso(), data: {} }]);
    time.advance(11 * 86_400_000);
    await store.appendEvents([{ id: 'evt_new', type: EVENT_TYPES.equipmentStateChanged, time: time.iso(), data: {} }]);
    const boot = startIntegrations({ store, env: { INTEGRATION_RETENTION_DAYS: '10' }, demo: false, storeKind: 'memory', now: time.now });
    closers.push(() => boot.stop());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await store.readEvents({ after: 0, limit: 10 })).items.map((row) => row.id)).toEqual(['evt_new']);
  });

  it('an invalid AAS_SECRET_KEY stops the start', async () => {
    expect(() => startIntegrations({ store: new InMemoryStore(), env: { AAS_SECRET_KEY: 'nope' }, demo: false, storeKind: 'postgres' })).toThrow(/AAS_SECRET_KEY/);
  });

  it('createHttpServer boots it and closing the server stops it', async () => {
    const server = createHttpServer({ store: new InMemoryStore() });
    const boot = integrationsOf(server)!;
    expect(boot).toBeDefined();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(boot.status().running).toEqual([]);
  });
});

const goldenBytes = readFileSync('tests/fixtures/01-roll-forming-machine.aasx');
const PASSWORD = '열자가넘는비밀번호입니다';

describe('end to end', () => {
  it('upload → edit → undo reach the feed and the webhook in revision order, with the right causes', async () => {
    const receiver = await startReceiver(() => ({ status: 204 }));
    closers.push(receiver.close);
    const store = new FolderStore(mkdtempSync(join(tmpdir(), 'aas-e2e-')));
    await store.init();
    await store.createUser({ login: 'admin', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
    const server = createHttpServer({
      store,
      storeKind: 'folder',
      integrationOverrides: {
        env: { INTEGRATIONS: 'on', AAS_INTEGRATION_ALLOW: 'receiver.test', AAS_SECRET_KEY: KEY.toString('base64') },
        resolve: async () => ['10.0.0.1'],
        send: async (attempt) => ({ ...(await sendWebhook({ ...attempt, address: '127.0.0.1' })), address: attempt.address }),
      },
    });
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const api = async (method: string, path: string, body?: unknown, type = 'application/json') =>
      fetch(`${base}${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': type }) },
        ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
      });

    const created = await (await api('POST', '/integrations/subscriptions', { name: 'MES', kind: 'webhook', url: `http://receiver.test:${receiver.port}/hook`, types: ['model.*'] })).json() as { secret: string };
    expect(created.secret).toMatch(/^whsec_/);
    // Let the dispatcher take its first cursor before anything happens
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const upload = await api('POST', '/packages?name=01.aasx', new Uint8Array(goldenBytes), 'application/octet-stream');
    const { packageId } = (await upload.json()) as { packageId: string };
    const submodel = readAasx(new Uint8Array(goldenBytes)).environment.submodels![0]!;
    const path = `/packages/${packageId}/api/v3.0/submodels/${Buffer.from(submodel.id).toString('base64url')}`;
    expect((await api('PUT', path, { ...submodel, idShort: `${submodel.idShort}Edited` })).status).toBeLessThan(300);
    expect((await api('POST', `/packages/${packageId}/undo`)).status).toBe(200);

    const feed = (await (await api('GET', '/integrations/events?types=model.*')).json()) as { items: { type: string; vxcause?: string; vxrevision?: number; id: string }[] };
    const relevant = feed.items.filter((item) => item.type === EVENT_TYPES.modelPackageCreated || item.type === EVENT_TYPES.modelSubmodelUpdated);
    expect(relevant.map((item) => [item.type, item.vxcause])).toEqual([
      [EVENT_TYPES.modelPackageCreated, 'import'],
      [EVENT_TYPES.modelSubmodelUpdated, 'edit'],
      [EVENT_TYPES.modelSubmodelUpdated, 'undo'],
    ]);
    const revisions = relevant.map((item) => item.vxrevision!);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);

    // The webhook receives the same events, signed
    for (let i = 0; i < 50 && receiver.requests.length < feed.items.length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const delivered = receiver.requests.map((request) => request.headers['webhook-id']);
    for (const item of relevant) expect(delivered).toContain(item.id);
    const first = receiver.requests[0]!;
    expect(
      verifySignature({
        secrets: [created.secret], id: String(first.headers['webhook-id']), timestamp: String(first.headers['webhook-timestamp']),
        signatureHeader: String(first.headers['webhook-signature']), body: first.body, nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
  }, 20_000);
});
