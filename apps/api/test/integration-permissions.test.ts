/**
 * Who may do what with integrations (design D11, §4; platform 7.5, ERP E-23).
 *
 * Important: subscriptions make this server connect outward with signed requests — an SSRF and exfiltration relay in
 *    the wrong hands. Only an admin **session** manages them: viewer, editor, full API key and an open server without
 *    accounts all get 403. The secret is shown only in the create / rotate responses and nowhere else.
 */
import { EVENT_TYPES } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { hashPassword } from '../src/password.js';
import { ADMIN, EDITOR, memoryStore, routeCaller, testServices, VIEWER, type Principal } from './helpers/integration-scenarios.js';

const PUBLIC = { 'mes.example.com': ['93.184.216.34'] };
const WEBHOOK = { name: 'MES', kind: 'webhook', url: 'https://mes.example.com/hook', types: ['equipment.*'] };

async function world() {
  const store = await memoryStore();
  const call = routeCaller(store, { demo: false, services: testServices({ resolve: PUBLIC }) });
  const created = await call('POST', '/integrations/subscriptions', { principal: ADMIN, body: WEBHOOK });
  const id: string = created.body.subscription.id;
  await store.enqueueDeliveries([{ subscriptionId: id, eventSeq: 1, eventId: 'evt_1' }], new Date().toISOString());
  const deliveryId = (await store.listDeliveries(id)).items[0]!.id;
  return { store, call, id, deliveryId, secret: created.body.secret as string };
}

const ADMIN_ROUTES = (id: string, deliveryId: string): [string, string, unknown?][] => [
  ['POST', '/integrations/subscriptions', WEBHOOK],
  ['GET', '/integrations/subscriptions'],
  ['GET', `/integrations/subscriptions/${id}`],
  ['PATCH', `/integrations/subscriptions/${id}`, { name: 'x' }],
  ['DELETE', `/integrations/subscriptions/${id}`],
  ['POST', `/integrations/subscriptions/${id}/rotate-secret`],
  ['POST', `/integrations/subscriptions/${id}/test`],
  ['POST', `/integrations/subscriptions/${id}/replay`, { fromSeq: '1' }],
  ['GET', `/integrations/subscriptions/${id}/deliveries`],
  ['POST', `/integrations/deliveries/${deliveryId}/redeliver`],
  ['GET', '/integrations/status'],
];

const CALLERS: [string, { principal?: Principal; headers?: Record<string, string> }][] = [
  ['viewer session', { principal: VIEWER }],
  ['editor session', { principal: EDITOR }],
  ['full API key (no session)', { headers: { authorization: 'Bearer full-key' } }],
  ['open server without accounts', {}],
];

describe('admin-only routes', () => {
  it.each(CALLERS)('%s → 403 on every subscription route, nothing changes', async (_name, as) => {
    const { call, id, deliveryId, store } = await world();
    const before = JSON.stringify(await store.listSubscriptions());
    for (const [method, path, body] of ADMIN_ROUTES(id, deliveryId)) {
      const reply = await call(method, path, { ...as, ...(body === undefined ? {} : { body }) });
      expect(reply.status, `${method} ${path}`).toBe(403);
    }
    expect(JSON.stringify(await store.listSubscriptions())).toBe(before);
  });

  it('an open server is told to create an admin first', async () => {
    const { call } = await world();
    const reply = await call('POST', '/integrations/subscriptions', { body: WEBHOOK });
    expect(reply.body.messages[0].text).toContain('관리자 계정을 만들고');
  });

  it('admin session passes every route', async () => {
    const { call, id, deliveryId } = await world();
    // DELETE last, so the routes after it still find the subscription
    const routes = ADMIN_ROUTES(id, deliveryId).sort(([a], [b]) => Number(a === 'DELETE') - Number(b === 'DELETE'));
    for (const [method, path, body] of routes) {
      const reply = await call(method, path, { principal: ADMIN, ...(body === undefined ? {} : { body }) });
      // test → 503 (workers off) and redeliver of a still pending row → 409 are passes of the permission check
      expect([200, 201, 204, 409, 503], `${method} ${path}`).toContain(reply.status);
    }
  });
});

describe('readers', () => {
  it('viewer and anonymous readers can read the feed and schemas', async () => {
    const { call } = await world();
    for (const as of [{ principal: VIEWER }, {}, { headers: { authorization: 'Bearer read-only' } }]) {
      expect((await call('GET', '/integrations/events', as)).status).toBe(200);
      expect((await call('GET', '/integrations/schemas', as)).status).toBe(200);
    }
  });
});

describe('Important: the secret appears only in the create and rotate responses', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });

  it('not in listings, single reads, delivery rows, audit events, the feed or logs', async () => {
    const { call, id, store, secret } = await world();
    const rotated = (await call('POST', `/integrations/subscriptions/${id}/rotate-secret`, { principal: ADMIN })).body.secret as string;
    const seen = [
      await call('GET', '/integrations/subscriptions', { principal: ADMIN }),
      await call('GET', `/integrations/subscriptions/${id}`, { principal: ADMIN }),
      await call('GET', `/integrations/subscriptions/${id}/deliveries`, { principal: ADMIN }),
      await call('GET', '/integrations/events', { principal: ADMIN }),
      await call('GET', '/integrations/status', { principal: ADMIN }),
    ].map((reply) => JSON.stringify(reply.body));
    seen.push(JSON.stringify(await store.readEvents({ after: 0, limit: 1000, includeAudit: true })));
    seen.push(JSON.stringify((await store.listDeliveries(id)).items));
    seen.push(logs.join('\n'));
    for (const value of [secret, rotated]) {
      const keyPart = value.slice('whsec_'.length);
      for (const text of seen) {
        expect(text).not.toContain(value);
        expect(text).not.toContain(keyPart);
      }
    }
    expect(seen[3]).toContain(EVENT_TYPES.integrationAudit);
  });
});

describe('through createApi (authentication happens before the routes)', () => {
  async function server() {
    const store = new InMemoryStore();
    await store.init();
    await store.createUser({ login: 'admin', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword('열자가넘는비밀번호입니다') });
    const handle = createApi(store, { auth: { tokens: ['full-key'], readOnlyTokens: ['read-key'] }, integrationServices: testServices({ resolve: PUBLIC }) });
    return (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      handle({ method, path, query: {}, headers, ...(body === undefined ? {} : { body }) } as ApiRequest);
  }

  it('no credentials with accounts → 401', async () => {
    const call = await server();
    expect((await call('GET', '/integrations/events')).status).toBe(401);
    expect((await call('POST', '/integrations/subscriptions', {}, WEBHOOK)).status).toBe(401);
  });

  it('read-only key cannot write (403); full key is not an admin session (403)', async () => {
    const call = await server();
    expect((await call('POST', '/integrations/subscriptions', { authorization: 'Bearer read-key' }, WEBHOOK)).status).toBe(403);
    expect((await call('POST', '/integrations/subscriptions', { authorization: 'Bearer full-key' }, WEBHOOK)).status).toBe(403);
  });

  it('read-only key reads the feed (through the workspace layer)', async () => {
    const call = await server();
    expect((await call('GET', '/integrations/events', { authorization: 'Bearer read-key' })).status).toBe(200);
  });
});
