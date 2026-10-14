/**
 * External references (design D1, D2, §4.5; ERP E-6, E-15, E-16, E-17, E-18; E-23 for refs).
 */
import { describe, expect, it } from 'vitest';
import { runInWorkspace, scopeStore } from '@aas/store';
import { encodeIdentifier } from '../src/base64url.js';
import { externalRefRoutes } from '../src/integration/routes-external-refs.js';
import { createIntegrationStore, type IntegrationTestStore } from './helpers/integration-store.js';
import { harness, shell, unitAsset, unitCopy, type Json } from './helpers/integration-fixtures.js';

const SAP = 'sap-s4:PRD:100';
const OWNER = 'https://sap.example.com/PRD/100';

async function setup(count = 1, options: Parameters<typeof harness>[2] = {}) {
  const store = createIntegrationStore();
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) ids.push((await store.importPackage({ name: `unit-${n}.aasx`, package: unitCopy(n) })).id);
  return { store, ids, ...harness(store, { demo: false }, options) };
}

function doc(n: number, refs: Json[], extra: Json[] = []): Json {
  return { schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'asset', globalAssetId: unitAsset(n) }, refs }, ...extra] };
}

const equipmentRef = (publish: boolean, id = '10004711'): Json => ({ system: SAP, type: 'equipment', id, publish, externalSubjectId: OWNER });
const costCenter = { system: SAP, type: 'costCenter', id: 'CC-4711' };
const secret = { system: 'icube:WACE', type: 'equipmentCode', id: 'EQ-SECRET', sensitive: true };

async function shellIds(store: IntegrationTestStore, packageId: string): Promise<Json[]> {
  const info = shell(await store.getEnvironment(packageId))['assetInformation'] as Json;
  return (info['specificAssetIds'] ?? []) as Json[];
}

function lookupQuery(name: string, value: string): Record<string, string> {
  return { assetIds: encodeIdentifier(JSON.stringify({ name, value })) };
}

describe('external refs document', () => {
  it('starts empty at revision 0 and needs If-Match to write (428, 412)', async () => {
    const { call, ids } = await setup();
    const empty = await call('GET', `/packages/${ids[0]}/external-refs`);
    expect(empty.body).toEqual({ value: { schema: 'vexplor.externalRefs/1', subjects: [] }, revision: 0 });
    expect(empty.headers['etag']).toBe('"0"');
    expect((await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, [costCenter]) })).status).toBe(428);
    const first = await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, [costCenter]), headers: { 'if-match': '"0"' } });
    expect(first.status).toBe(200);
    expect(first.headers['etag']).toBe('"1"');
    // E-16: a stale revision
    expect((await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, []), headers: { 'if-match': '"0"' } })).status).toBe(412);
    expect((await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, []), headers: { 'if-match': '"1"' } })).status).toBe(200);
  });

  it('refuses invalid documents with JSON pointers (400)', async () => {
    const { call, ids } = await setup();
    const put = (body: unknown) => call('PUT', `/packages/${ids[0]}/external-refs`, { body, headers: { 'if-match': '0' } });
    const cases: [unknown, string][] = [
      [doc(1, [{ ...costCenter, publish: true }]), '/subjects/0/refs/0/publish'],
      [doc(1, [{ ...secret, publish: true }]), '/subjects/0/refs/0/publish'],
      [doc(1, [{ system: 'sap|x', type: 'equipment', id: '1' }]), '/subjects/0/refs/0/system'],
      [doc(1, [{ system: SAP, type: 'equipment', id: '' }]), '/subjects/0/refs/0/id'],
      [doc(1, [{ ...costCenter, readOnly: true }]), '/subjects/0/refs/0/readOnly'],
      [doc(1, [equipmentRef(false), equipmentRef(false, '2')]), '/subjects/0/refs/1'],
      [{ schema: 'other', subjects: [] }, '/schema'],
      [{ schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'consumable', globalAssetId: unitAsset(1) }, refs: [] }] }, '/subjects/0/subject/key'],
    ];
    for (const [body, pointer] of cases) {
      const response = await put(body);
      expect(response.status, pointer).toBe(400);
      expect((response.body as { errors: { path: string }[] }).errors.map((e) => e.path), pointer).toContain(pointer);
    }
    // An asset subject must be an asset of this package
    expect((await put(doc(2, [costCenter]))).status).toBe(400);
  });

  it('rejects a key already claimed by another package with 409 listing both claims (E-15)', async () => {
    const { call, ids } = await setup(2);
    await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, [equipmentRef(false)]), headers: { 'if-match': '0' } });
    const clash = await call('PUT', `/packages/${ids[1]}/external-refs`, { body: doc(2, [equipmentRef(false)]), headers: { 'if-match': '0' } });
    expect(clash.status).toBe(409);
    const claims = (clash.body as { claims: Json[] }).claims;
    expect(claims.map((claim) => claim['packageId'])).toEqual([ids[0], ids[1]]);
    expect(claims.every((claim) => claim['id'] === '10004711')).toBe(true);
  });
});

describe('cost centre and sensitive types regardless of spelling (L7)', () => {
  it('normalises the type case at parse time and keeps CostCenter out of the shell, exports and join', async () => {
    const { store, call, ids } = await setup();
    const packageId = ids[0]!;
    expect((await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [{ system: SAP, type: 'CostCenter', id: 'CC-9', publish: true }]), headers: { 'if-match': '0' } })).status).toBe(400);
    const put = await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [{ system: SAP, type: 'COSTCENTER', id: 'CC-9' }, { system: SAP, type: 'Equipment', id: 'EQ-1' }]), headers: { 'if-match': '0' } });
    expect(put.status).toBe(200);
    const stored = (await store.getExternalRefs(packageId))!.value.subjects[0]!.refs.map((ref) => ref.type);
    expect(stored).toEqual(['costCenter', 'equipment']);
    const item = ((await call('GET', '/integrations/exports/equipment')).body as { items: Json[] }).items[0]!;
    expect(item['externalRefs']).toEqual([{ system: SAP, type: 'equipment', id: 'EQ-1' }]);
    // The import goes through the same parser
    const imported = await call('POST', '/integrations/external-refs/import', {
      query: { dryRun: '1' },
      body: { rows: [{ globalAssetId: unitAsset(1), system: SAP, type: 'costcenter', id: 'CC-10', publish: true }] },
    });
    expect((imported.body as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('keeps a differently spelled cost centre out even when the store holds it unnormalised', async () => {
    const { store, call, ids } = await setup();
    // Written past the API (an older import, a hand-edited backup): the read side must still filter it
    await store.putExternalRefs(ids[0]!, { schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'asset', globalAssetId: unitAsset(1) }, refs: [{ system: SAP, type: 'CostCenter', id: 'CC-9' }] }] }, 0);
    const item = ((await call('GET', '/integrations/exports/equipment')).body as { items: Json[] }).items[0]!;
    expect(item['externalRefs']).toEqual([]);
  });
});

describe('undo and external refs (L9)', () => {
  it('does not offer undo for a refs change, and drops older snapshots that would revert its projection', async () => {
    const { call, ids } = await setup();
    const packageId = ids[0]!;
    // An ordinary edit first — its snapshot predates the projection and must not survive the refs change
    const serial = `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier('https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1')}/submodel-elements/SerialNumber/$value`;
    expect((await call('PATCH', serial, { body: 'SN-EDIT' })).status).toBeLessThan(300);
    expect(((await call('GET', `/packages/${packageId}/undo`)).body as { undo: string[] }).undo).toHaveLength(1);
    const put = await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [equipmentRef(true)]), headers: { 'if-match': '0' } });
    expect(put.status).toBe(200);
    expect(((await call('GET', `/packages/${packageId}/undo`)).body as { undo: string[] }).undo).toEqual([]);
    expect((await call('POST', `/packages/${packageId}/undo`)).status).toBe(409);
  });
});

describe('projection into specificAssetIds', () => {
  it('publishes into the shell so discovery finds it; unpublishing removes it; cost centre never (E-17)', async () => {
    const { store, call, ids } = await setup();
    const packageId = ids[0]!;
    // A specificAssetId a person typed in — the projection must leave it alone
    const env = await store.getEnvironment(packageId);
    const aas = shell(env);
    (aas['assetInformation'] as Json)['specificAssetIds'] = [{ name: 'serialNumber', value: 'EXM-RFL-2026-00127' }];
    await store.updateIdentifiable(packageId, 'AssetAdministrationShell', String(aas['id']), aas);

    const put = await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [equipmentRef(true), costCenter, secret]), headers: { 'if-match': '0' } });
    expect(put.status).toBe(200);
    expect((put.body as Json)['projected']).toEqual({ added: [{ name: `${SAP}:equipment`, value: '10004711' }], removed: [] });
    expect(await shellIds(store, packageId)).toEqual([
      { name: 'serialNumber', value: 'EXM-RFL-2026-00127' },
      { name: `${SAP}:equipment`, value: '10004711', externalSubjectId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: OWNER }] } },
    ]);
    const found = await call('GET', '/api/v3.0/lookup/shells', { query: lookupQuery(`${SAP}:equipment`, '10004711') });
    expect((found.body as { result: string[] }).result).toEqual([String(aas['id'])]);
    expect(((await call('GET', '/api/v3.0/lookup/shells', { query: lookupQuery(`${SAP}:costCenter`, 'CC-4711') })).body as { result: string[] }).result).toEqual([]);

    // The shell change went through the normal edit path, marked with its cause
    const page = await store.readEvents({ after: 0, limit: 1000 });
    const shellUpdates = page.items.filter((event) => event.type === 'kr.vexplor.aas.model.shell.updated.v1');
    expect(shellUpdates.at(-1)!.cause).toBe('external-refs');

    const unpublish = await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [equipmentRef(false), costCenter]), headers: { 'if-match': '1' } });
    expect((unpublish.body as Json)['projected']).toEqual({ added: [], removed: [{ name: `${SAP}:equipment`, value: '10004711' }] });
    expect(await shellIds(store, packageId)).toEqual([{ name: 'serialNumber', value: 'EXM-RFL-2026-00127' }]);
    expect(((await call('GET', '/api/v3.0/lookup/shells', { query: lookupQuery(`${SAP}:equipment`, '10004711') })).body as { result: string[] }).result).toEqual([]);
  });

  it('keeps refs out of the AASX unless published (E-18)', async () => {
    const { store, call, ids } = await setup();
    const packageId = ids[0]!;
    const aasx = async () => JSON.stringify((await store.exportPackage(packageId)).environment);
    await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [equipmentRef(false), costCenter, secret]), headers: { 'if-match': '0' } });
    expect(await aasx()).not.toContain('10004711');
    await call('PUT', `/packages/${packageId}/external-refs`, { body: doc(1, [equipmentRef(true), costCenter, secret]), headers: { 'if-match': '1' } });
    const published = await aasx();
    expect(published).toContain('10004711');
    expect(published).not.toContain('CC-4711');
    expect(published).not.toContain('EQ-SECRET');
  });

  it('shows only public refs in the equipment export — never cost centres or sensitive refs (D1)', async () => {
    const { call, ids } = await setup();
    await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, [equipmentRef(false), costCenter, secret]), headers: { 'if-match': '0' } });
    const item = ((await call('GET', '/integrations/exports/equipment')).body as { items: Json[] }).items[0]!;
    expect(item['externalRefs']).toEqual([{ system: SAP, type: 'equipment', id: '10004711' }]);
    const csv = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } })).body as Uint8Array);
    expect(csv).not.toContain('CC-4711');
    expect(csv).not.toContain('EQ-SECRET');
  });
});

describe('external refs import', () => {
  const header = 'globalAssetId,subjectKind,subjectKey,system,type,id,publish,sensitive,externalSubjectId';
  const csv = (...rows: string[]) => new TextEncoder().encode([header, ...rows].join('\r\n'));
  const rows = [
    `${unitAsset(1)},asset,,${SAP},equipment,10004711,true,,${OWNER}`,
    `${unitAsset(1)},asset,,${SAP},costCenter,CC-4711,,,`,
    `${unitAsset(1)},bomChild,https://www.smart-factory.kr/ids/asset/Uncoiler/1/0,${SAP},material,MAT-UNC-1,,,`,
    `${unitAsset(1)},consumable,CONS-01,${SAP},material,MAT-ROLL-150,,,`,
  ];

  it('shows the diff on a dry run without writing, applies it, and is idempotent (E-6)', async () => {
    const { store, call, ids } = await setup();
    const dry = await call('POST', '/integrations/external-refs/import', { query: { dryRun: '1' }, body: csv(...rows), headers: { 'content-type': 'text/csv' } });
    expect(dry.status).toBe(200);
    const dryBody = dry.body as { changes: { packageId: string; add: Json[]; remove: Json[] }[]; errors: unknown[]; conflicts: unknown[] };
    expect(dryBody.errors).toEqual([]);
    expect(dryBody.changes).toHaveLength(1);
    expect(dryBody.changes[0]!.add).toHaveLength(4);
    expect(await store.getExternalRefs(ids[0]!)).toBeUndefined();

    const applied = await call('POST', '/integrations/external-refs/import', { body: csv(...rows), headers: { 'content-type': 'text/csv' } });
    expect(applied.status).toBe(200);
    expect((applied.body as { revisions: Record<string, number> }).revisions).toEqual({ [ids[0]!]: 1 });
    expect(await shellIds(store, ids[0]!)).toEqual([expect.objectContaining({ name: `${SAP}:equipment`, value: '10004711' })]);
    const audit = (await store.readEvents({ after: 0, limit: 1000, includeAudit: true })).items.filter((event) => event.type === 'kr.vexplor.aas.integration.audit.v1');
    expect(audit.map((event) => (event.data as Json)['action'])).toEqual(['external-refs.imported']);

    const again = await call('POST', '/integrations/external-refs/import', { query: { dryRun: '1' }, body: csv(...rows), headers: { 'content-type': 'text/csv' } });
    expect((again.body as { changes: unknown[] }).changes).toEqual([]);

    // The BOM export picks the material up for the mapped child
    const bom = ((await call('GET', '/integrations/exports/bom', { query: { packageId: ids[0]! } })).body as { items: Json[] }).items;
    const uncoiler = bom.find((row) => row['childName'] === 'Uncoiler')!;
    expect(uncoiler['erpMaterial']).toEqual([{ system: SAP, id: 'MAT-UNC-1' }]);
    expect(uncoiler['mapped']).toBe(true);
  });

  it('updates a changed id, never deletes refs that are not in the file', async () => {
    const { store, call, ids } = await setup();
    await call('POST', '/integrations/external-refs/import', { body: csv(...rows), headers: { 'content-type': 'text/csv' } });
    const changed = await call('POST', '/integrations/external-refs/import', {
      body: { rows: [{ globalAssetId: unitAsset(1), system: SAP, type: 'equipment', id: '10009999', publish: true }] },
    });
    expect(changed.status).toBe(200);
    const change = (changed.body as { changes: { add: Json[]; remove: Json[] }[] }).changes[0]!;
    expect(change.add.map((ref) => ref['id'])).toEqual(['10009999']);
    expect(change.remove.map((ref) => ref['id'])).toEqual(['10004711']);
    const stored = (await store.getExternalRefs(ids[0]!))!.value.subjects.flatMap((subject) => subject.refs.map((ref) => ref.id)).sort();
    expect(stored).toEqual(['10009999', 'CC-4711', 'MAT-ROLL-150', 'MAT-UNC-1']);
  });

  it('reports row errors and conflicts, and applies nothing while any exist', async () => {
    const { store, call, ids } = await setup(2);
    await call('PUT', `/packages/${ids[1]}/external-refs`, { body: doc(2, [equipmentRef(false)]), headers: { 'if-match': '0' } });
    const body = csv(
      `${unitAsset(1)},asset,,${SAP},equipment,10004711,,,`,
      `https://nowhere.example/asset,asset,,${SAP},equipment,1,,,`,
      `${unitAsset(1)},asset,,${SAP},costCenter,CC-1,true,,`,
      `${unitAsset(1)},asset,,${SAP},plant,1000,maybe,,`,
    );
    const dry = (await call('POST', '/integrations/external-refs/import', { query: { dryRun: '1' }, body, headers: { 'content-type': 'text/csv' } })).body as {
      errors: { row: number }[];
      conflicts: Json[];
    };
    expect(dry.errors.map((error) => error.row)).toEqual([3, 4, 5]);
    expect(dry.conflicts).toEqual([expect.objectContaining({ id: '10004711', packageId: ids[0], claimedBy: { packageId: ids[1], subject: `asset|${unitAsset(2)}` } })]);
    const apply = await call('POST', '/integrations/external-refs/import', { body, headers: { 'content-type': 'text/csv' } });
    expect(apply.status).toBe(422);
    expect(await store.getExternalRefs(ids[0]!)).toBeUndefined();
  });
});

describe('import is all or nothing (M4)', () => {
  it('writes no package when another package changed between planning and saving', async () => {
    const { store, call, ids } = await setup(2);
    const read = store.getExternalRefs.bind(store);
    let raced = false;
    // A concurrent writer saves package 2 right after the import planned it
    (store as unknown as { getExternalRefs: typeof read }).getExternalRefs = async (packageId) => {
      const current = await read(packageId);
      if (packageId === ids[1] && !raced) {
        raced = true;
        await store.putExternalRefs(packageId, { schema: 'vexplor.externalRefs/1', subjects: [] }, 0);
      }
      return current;
    };
    const response = await call('POST', '/integrations/external-refs/import', {
      body: {
        rows: [
          { globalAssetId: unitAsset(1), system: SAP, type: 'equipment', id: 'EQ-1' },
          { globalAssetId: unitAsset(2), system: SAP, type: 'equipment', id: 'EQ-2' },
        ],
      },
    });
    expect(response.status).toBe(412);
    expect(await read(ids[0]!)).toBeUndefined();
    expect(await shellIds(store, ids[0]!)).toEqual([]);
  });

  it('reports a key held in another workspace on the dry run, with the holder masked, and applies nothing', async () => {
    const base = createIntegrationStore();
    const scoped = scopeStore(base);
    const alice = { key: 'user:alice', seesAll: false };
    const bob = { key: 'user:bob', seesAll: false };
    const a = await runInWorkspace(alice, () => scoped.importPackage({ name: 'a.aasx', package: unitCopy(3) }));
    await base.putExternalRefs(a.id, doc(3, [{ system: SAP, type: 'equipment', id: 'EQ-9' }]) as never, 0);
    const b1 = await runInWorkspace(bob, () => scoped.importPackage({ name: 'b1.aasx', package: unitCopy(1) }));
    await runInWorkspace(bob, () => scoped.importPackage({ name: 'b2.aasx', package: unitCopy(2) }));
    const route = externalRefRoutes(scoped, { demo: false }).find((r) => r.pattern === '/integrations/external-refs/import')!;
    const rows = [
      { globalAssetId: unitAsset(1), system: SAP, type: 'equipment', id: 'EQ-1' },
      { globalAssetId: unitAsset(2), system: SAP, type: 'equipment', id: 'EQ-9' },
    ];
    const post = (query: Record<string, string>) =>
      runInWorkspace(bob, () => route.handle({ request: { method: 'POST', path: '', query, queryAll: {}, headers: {}, body: { rows } }, params: {} }));
    const dry = (await post({ dryRun: '1' })).body as { conflicts: Json[] };
    expect(dry.conflicts).toHaveLength(1);
    expect(dry.conflicts[0]!['id']).toBe('EQ-9');
    expect(JSON.stringify(dry.conflicts)).not.toContain(a.id);
    expect((await post({})).status).toBe(422);
    expect(await base.getExternalRefs(b1.id)).toBeUndefined();
  });
});

describe('permissions (E-23, refs part)', () => {
  it('lets a read-only key read refs and exports but not write or import them; no key is 401', async () => {
    const { call, ids } = await setup(1, { auth: { tokens: ['full-key'], readOnlyTokens: ['read-key'] } });
    const read = { authorization: 'Bearer read-key' };
    expect((await call('GET', `/packages/${ids[0]}/external-refs`, { headers: read })).status).toBe(200);
    expect((await call('GET', '/integrations/exports/equipment', { headers: read })).status).toBe(200);
    expect((await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, []), headers: { ...read, 'if-match': '0' } })).status).toBe(403);
    expect((await call('POST', '/integrations/external-refs/import', { body: { rows: [] }, headers: read })).status).toBe(403);
    expect((await call('GET', `/packages/${ids[0]}/external-refs`)).status).toBe(401);
    expect((await call('PUT', `/packages/${ids[0]}/external-refs`, { body: doc(1, []), headers: { authorization: 'Bearer full-key', 'if-match': '0' } })).status).toBe(200);
  });
});
