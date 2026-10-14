/**
 * How the merged work packages are wired together (WP3 §13.3): environment values as docker-compose passes them,
 * one instance id everywhere, the OPC UA trust store also with integrations off, and audit events in private
 * workspaces written through the unscoped store.
 */
import { readFileSync } from 'node:fs';

import { EVENT_TYPES } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { describe, expect, it } from 'vitest';

import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import { startIntegrations } from '../src/integration/boot.js';
import { egressPolicyFromEnv } from '../src/integration/egress.js';
import { opcuaModeFromEnv, opcuaPkiDirFromEnv } from '../src/integration/opcua-env.js';
import { loadMasterKey } from '../src/integration/secrets.js';
import { hashPassword } from '../src/password.js';
import { ADMIN, memoryStore, routeCaller, testServices, VIEWER } from './helpers/integration-scenarios.js';

describe("environment: docker-compose passes '' for unset variables — '' means not set", () => {
  it('AAS_SECRET_KEY=\'\' is no key (not an invalid one)', () => {
    expect(loadMasterKey({ env: { AAS_SECRET_KEY: '' }, storeKind: 'memory' }).source).toBe('ephemeral');
    expect(loadMasterKey({ env: { AAS_SECRET_KEY: '' }, storeKind: 'postgres' }).source).toBe('missing');
    expect(() => startIntegrations({ store: new InMemoryStore(), env: { AAS_SECRET_KEY: '', AAS_INTEGRATION_ALLOW: '' }, demo: false, storeKind: 'memory' })).not.toThrow();
  });

  it("AAS_INTEGRATION_ALLOW='' allows nothing extra", () => {
    expect(egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: '' }, false).allow).toEqual([]);
    expect(egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: ' , ' }, false).allow).toEqual([]);
  });

  it("OPCUA_ALLOW_INSECURE='' is secure; only 'on' opens it", () => {
    expect(opcuaModeFromEnv({ OPCUA_ALLOW_INSECURE: '' })).toBe('secure');
    expect(opcuaModeFromEnv({})).toBe('secure');
    expect(opcuaModeFromEnv({ OPCUA_ALLOW_INSECURE: 'off' })).toBe('secure');
    expect(opcuaModeFromEnv({ OPCUA_ALLOW_INSECURE: 'on' })).toBe('insecure');
  });

  it("OPCUA_PKI_DIR='' falls back to <AAS_DATA_DIR>/opcua-pki, then ./opcua-pki", () => {
    expect(opcuaPkiDirFromEnv({ OPCUA_PKI_DIR: '', AAS_DATA_DIR: '/data' })).toBe('/data/opcua-pki');
    expect(opcuaPkiDirFromEnv({ OPCUA_PKI_DIR: '', AAS_DATA_DIR: '' })).toBe('opcua-pki');
    expect(opcuaPkiDirFromEnv({ OPCUA_PKI_DIR: '/pki' })).toBe('/pki');
  });
});

describe('one instance id for event sources, the server config and export envelopes', () => {
  it('GET /integrations/config shows it before any save; PUT keeps it; exports carry it', async () => {
    const store = await memoryStore();
    const services = testServices();
    const call = routeCaller(store, { demo: false, services });
    const id = await services.instanceId();
    const read = await call('GET', '/integrations/config', { principal: VIEWER });
    expect(read.body).toMatchObject({ revision: 0, value: { instanceId: id } });
    const saved = await call('PUT', '/integrations/config', { principal: ADMIN, headers: { 'if-match': '"0"' }, body: { ...read.body.value, instanceId: 'ffffffffffff' } });
    expect(saved.status).toBe(200);
    expect(saved.body.value.instanceId).toBe(id);
    const exported = await call('GET', '/integrations/exports/equipment', { principal: VIEWER });
    expect(exported.body.source.instanceId).toBe(id);
  });

  it('the boot keeps the id the config already holds', async () => {
    const store = await memoryStore();
    await store.putServerIntegrationConfig({ schema: 'vexplor.serverIntegrationConfig/1', instanceId: 'abcdefabcdef' });
    expect(await startIntegrations({ store, env: {}, demo: false, storeKind: 'memory' }).services.instanceId()).toBe('abcdefabcdef');
  });
});

describe('OPC UA trust store', () => {
  it('is reachable through runtime also with INTEGRATIONS off (certificate routes need it)', async () => {
    const pki = { list: async () => ({ trusted: [], rejected: [] }), trust: async () => false };
    const boot = startIntegrations({ store: await memoryStore(), env: {}, demo: false, storeKind: 'memory', opcuaPki: () => pki });
    expect(boot.enabled).toBe(false);
    expect(boot.runtimeDeps.opcuaPki?.()).toBe(pki);
    const call = routeCaller(await memoryStore(), { demo: false, runtime: boot.runtimeDeps });
    expect((await call('GET', '/integrations/opcua/certificates', { principal: ADMIN })).status).toBe(200);
    await boot.stop();
  });
});

describe('Important: audit events in a private workspace are recorded (through the unscoped store)', () => {
  it("an editor changing their own package's integration config leaves an audit event", async () => {
    const store = new InMemoryStore();
    await store.init();
    const password = '열자가넘는비밀번호입니다';
    await store.createUser({ login: 'admin', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword(password) });
    await store.createUser({ login: 'kim', displayName: 'Kim', role: 'editor', passwordHash: await hashPassword(password) });
    const handle = createApi(store, { privateWorkspaces: true, integrationServices: testServices() });
    const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown, query: Record<string, string> = {}) =>
      handle({ method, path, query, queryAll: {}, headers, ...(body === undefined ? {} : { body }) } as ApiRequest);
    const login = await send('POST', '/auth/login', {}, { login: 'kim', password });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const upload = await send(
      'POST',
      '/packages',
      { cookie, 'content-type': 'application/octet-stream' },
      new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')),
      { name: '01.aasx' },
    );
    expect(upload.status).toBe(201);
    const packageId = (upload.body as { packageId: string }).packageId;
    const put = await send('PUT', `/packages/${packageId}/integration-config`, { cookie, 'if-match': '"0"' }, { schema: 'vexplor.packageIntegrationConfig/1' });
    expect(put.status).toBe(200);
    const audit = (await store.readEvents({ after: 0, limit: 1000, includeAudit: true })).items.filter((row) => row.type === EVENT_TYPES.integrationAudit);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorName: 'Kim', packageId, data: { action: 'config.updated', target: `packages/${packageId}` } });
  });
});
