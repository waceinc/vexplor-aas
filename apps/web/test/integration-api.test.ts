// @vitest-environment jsdom
/**
 * Integration API client: URLs, If-Match headers, error codes. Built against the contract (design §4) with a mocked fetch,
 * because the server routes arrive in other work packages.
 */
import { defaultServerIntegrationConfig } from '@aas/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimsOf, exportPath, feedUrl, ifMatch, IntegrationError, integrationApi, isMissingRoute, isStale, query } from '../src/api/integration.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers every request with one response and records what was sent */
function answer(status: number, body?: unknown, headers: Record<string, string> = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : payload, { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('integration API client — URLs', () => {
  it('builds export URLs with only the options that apply', () => {
    expect(exportPath('equipment', { format: 'csv', bom: true, koreanHeaders: true, includeTypes: true, lang: 'ko' })).toBe(
      '/integrations/exports/equipment?format=csv&bom=1&headers=ko&includeTypes=1&lang=ko',
    );
    // JSON ignores the CSV options; includeTypes belongs to the equipment export only
    expect(exportPath('bom', { packageId: 'pkg 1', format: 'json', bom: true, koreanHeaders: true, includeTypes: true })).toBe(
      '/integrations/exports/bom?packageId=pkg%201&format=json',
    );
  });

  it('leaves out undefined, false and empty values and quotes revisions as entity tags', () => {
    expect(query({ a: undefined, b: false, c: '', d: 0, e: true })).toBe('?d=0&e=1');
    expect(query({})).toBe('');
    expect(ifMatch(7)).toBe('"7"');
    expect(feedUrl('http://aas.local/')).toBe('http://aas.local/integrations/events?after=0');
  });
});

describe('integration API client — requests', () => {
  it('sends If-Match with the loaded revision when saving the server config', async () => {
    const calls = answer(200, { value: defaultServerIntegrationConfig('9f2c4e1a7b3d'), revision: 4 });
    await integrationApi.saveServerConfig(defaultServerIntegrationConfig('9f2c4e1a7b3d'), 3);
    expect(calls[0]!.url).toBe('/integrations/config');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers['if-match']).toBe('"3"');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('sends If-Match "0" for a package config that was never saved', async () => {
    const calls = answer(200, { value: null, revision: 1 });
    await integrationApi.savePackageConfig('pkg_1', { schema: 'vexplor.packageIntegrationConfig/1' } as never, 0);
    expect(calls[0]!.url).toBe('/packages/pkg_1/integration-config');
    expect(calls[0]!.headers['if-match']).toBe('"0"');
  });

  it('posts CSV as text/csv and marks a dry run', async () => {
    const calls = answer(200, { changes: [], errors: [], conflicts: [] });
    await integrationApi.importExternalRefs('globalAssetId,subjectKind\n', true);
    expect(calls[0]!.url).toBe('/integrations/external-refs/import?dryRun=1');
    expect(calls[0]!.headers['content-type']).toBe('text/csv');
    expect(calls[0]!.body).toBe('globalAssetId,subjectKind\n');
    await integrationApi.importExternalRefs('x', false);
    expect(calls[1]!.url).toBe('/integrations/external-refs/import');
  });

  it('encodes ids in paths and builds the deliveries query', async () => {
    const calls = answer(200, { items: [] });
    await integrationApi.deliveries('sub/1', { status: 'dead', limit: 50, cursor: '9' });
    expect(calls[0]!.url).toBe('/integrations/subscriptions/sub%2F1/deliveries?status=dead&limit=50&cursor=9');
  });

  it('accepts 204 for a delete', async () => {
    answer(204);
    await expect(integrationApi.deleteSubscription('sub_1')).resolves.toBeUndefined();
  });
});

describe('integration API client — errors', () => {
  it('keeps the server error code and text', async () => {
    answer(422, { messages: [{ code: 'TargetNotAllowed', text: '10.0.0.5 is a private address' }] });
    const caught = await integrationApi.createSubscription({ name: 'MES', kind: 'webhook', url: 'http://10.0.0.5/', types: ['equipment.*'] }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(IntegrationError);
    expect((caught as IntegrationError).code).toBe('TargetNotAllowed');
    expect((caught as IntegrationError).message).toBe('10.0.0.5 is a private address');
  });

  it('recognises a stale revision (412) and a missing route (404)', async () => {
    answer(412, { messages: [{ code: 'PreconditionFailed', text: 'stale' }] });
    expect(isStale(await integrationApi.serverConfig().catch((e: unknown) => e))).toBe(true);
    answer(404, 'not json', { 'content-type': 'text/plain' });
    const missing = await integrationApi.serverConfig().catch((e: unknown) => e);
    expect(isMissingRoute(missing)).toBe(true);
    expect(isStale(missing)).toBe(false);
  });

  it('reads 409 claims from the body', async () => {
    const claims = [{ system: 'sap-s4:PRD:100', type: 'equipment', id: '10002345', packageId: 'pkg_2', subject: 'asset|urn:a' }];
    answer(409, { messages: [{ code: 'ExternalRefConflict', text: 'taken' }], claims });
    const caught = await integrationApi.saveExternalRefs('pkg_1', { schema: 'vexplor.externalRefs/1', subjects: [] }, 1).catch((e: unknown) => e);
    expect(claimsOf(caught)).toEqual(claims);
    expect(claimsOf(new Error('x'))).toEqual([]);
  });

  it('downloads an export under the server-given file name', async () => {
    const calls = answer(200, 'key,aasId\r\n', { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="vexplor.equipmentMaster-1-2026-10-14.csv"' });
    const created = vi.fn(() => 'blob:x');
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const name = await integrationApi.downloadExport('equipment', { format: 'csv', bom: true });
    expect(name).toBe('vexplor.equipmentMaster-1-2026-10-14.csv');
    expect(calls[0]!.url).toBe('/integrations/exports/equipment?format=csv&bom=1');
    expect(created).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it('turns a refused export into an error with the server code', async () => {
    answer(422, { messages: [{ code: 'BomRootMismatch', text: 'root differs' }] });
    const caught = await integrationApi.downloadExport('bom', { packageId: 'pkg_1', format: 'json' }).catch((e: unknown) => e);
    expect((caught as IntegrationError).code).toBe('BomRootMismatch');
    expect((caught as IntegrationError).status).toBe(422);
  });
});
