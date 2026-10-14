/**
 * AAS Registry & Discovery.
 *
 * Important: the point of this test: **can an AAS be found by asset number?**
 * Field systems do not know the AAS id — they come with an equipment number or serial number.
 *
 * Important: and **do registration and reality never diverge?** We derive registrations instead of accepting them, so
 *    deleting a file must make it disappear from the registry immediately.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
const encode = (text: string): string => Buffer.from(text).toString('base64url');

const AAS_ID = 'https://www.smart-factory.kr/ids/aas/RollFormingMachine/1/0';
const ASSET_ID = 'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0';

async function seeded() {
  const store = new InMemoryStore();
  await store.init();
  const record = await store.importPackage({ name: '01.aasx', package: readAasx(goldenBytes) });
  const handle = createApi(store, { publicBaseUrl: 'https://factory.example.com' });
  const call = async (path: string, query: Record<string, string> = {}) => {
    const response = await handle({
      method: 'GET',
      path,
      query,
      queryAll: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])),
      headers: {},
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
  return { store, packageId: record.id, call, handle };
}

describe('AAS registry', () => {
  it('reports owned AASs as descriptors', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    expect(result.status).toBe(200);
    expect(result.body.result).toHaveLength(1);
    expect(result.body.result[0].id).toBe(AAS_ID);
    expect(result.body.result[0].idShort).toBe('RollFormingMachine');
  });

  it('Important: includes the address to fetch from — that is all a registry is', async () => {
    const { call, packageId } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    const endpoint = result.body.result[0].endpoints[0];
    expect(endpoint.interface).toBe('AAS-3.0');
    expect(endpoint.protocolInformation.href).toBe(
      `https://factory.example.com/packages/${packageId}/api/v3.0/shells/${encode(AAS_ID)}`,
    );
  });

  it('submodel descriptors come along (each with its own address)', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    const submodels = result.body.result[0].submodelDescriptors;
    expect(submodels.length).toBe(7);
    expect(submodels[0].endpoints[0].interface).toBe('SUBMODEL-3.0');
    expect(submodels[0].endpoints[0].protocolInformation.href).toContain('/submodels/');
  });

  it('can pick a single one by id', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/shell-descriptors/${encode(AAS_ID)}`);
    expect(result.status).toBe(200);
    expect(result.body.id).toBe(AAS_ID);
  });

  it('an unknown id is 404 — does not pretend it exists', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/shell-descriptors/${encode('https://example.com/없음')}`);
    expect(result.status).toBe(404);
  });

  it('submodels can also be looked up on their own', async () => {
    const { call } = await seeded();
    const all = await call('/api/v3.0/submodel-descriptors');
    expect(all.body.result.length).toBe(7);
    const one = await call(
      `/api/v3.0/submodel-descriptors/${encode('https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1')}`,
    );
    expect(one.body.idShort).toBe('DigitalNameplate');
  });

  it('can filter by assetKind (this project deliverables are Type)', async () => {
    const { call } = await seeded();
    expect((await call('/api/v3.0/shell-descriptors', { assetKind: 'Type' })).body.result).toHaveLength(1);
    expect((await call('/api/v3.0/shell-descriptors', { assetKind: 'Instance' })).body.result).toHaveLength(0);
  });
});

describe('discovery — finding an AAS by asset number', () => {
  it('Important: finds an AAS by globalAssetId — the field does not know the AAS id', async () => {
    const { call } = await seeded();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }));
    const result = await call('/api/v3.0/lookup/shells', { assetIds });
    expect(result.body.result).toEqual([AAS_ID]);
  });

  it('an unknown asset gives an empty list (not 404 — nothing was found, that is all)', async () => {
    const { call } = await seeded();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: 'urn:없는자산' }));
    const result = await call('/api/v3.0/lookup/shells', { assetIds });
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual([]);
  });

  it('accepts a raw JSON query too — implementations commonly send it that way', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/lookup/shells', {
      assetIds: JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }),
    });
    expect(result.body.result).toEqual([AAS_ID]);
  });

  it('returns the asset identifiers an AAS has', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/lookup/shells/${encode(AAS_ID)}`);
    expect(result.body).toEqual([{ name: 'globalAssetId', value: ASSET_ID }]);
  });

  it('asking with no conditions returns everything', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/lookup/shells');
    expect(result.body.result).toEqual([AAS_ID]);
  });
});

describe('discovery — a name is required and must match (design §4.7)', () => {
  /** Two AASs: one whose globalAssetId is "EQ-07", one that has "EQ-07" only as its serial number */
  async function twoAssets() {
    const { store, packageId, call } = await seeded();
    const shell = (await store.getIdentifiable(packageId, 'AssetAdministrationShell', AAS_ID))!;
    const content = structuredClone(shell.content) as { assetInformation: Record<string, unknown> };
    content.assetInformation['specificAssetIds'] = [{ name: 'SerialNumber', value: 'EQ-07' }];
    await store.updateIdentifiable(packageId, 'AssetAdministrationShell', AAS_ID, content);

    const other = await store.importPackage({ name: '02.aasx', package: readAasx(goldenBytes) });
    const otherShell = (await store.getIdentifiable(other.id, 'AssetAdministrationShell', AAS_ID))!;
    const otherContent = structuredClone(otherShell.content) as { id: string; assetInformation: Record<string, unknown> };
    otherContent.id = 'urn:test:aas:eq07';
    otherContent.assetInformation['globalAssetId'] = 'EQ-07';
    await store.deleteIdentifiable(other.id, 'AssetAdministrationShell', AAS_ID);
    await store.createIdentifiable(other.id, otherContent);
    return { call };
  }
  const query = (value: object) => ({ assetIds: encode(JSON.stringify(value)) });

  it('an entry without name is 400 — it used to be read as globalAssetId', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/lookup/shells', query({ value: ASSET_ID }));
    expect(result.status).toBe(400);
    expect(result.body.messages[0].text).toContain('SpecificAssetId.name');
  });

  it('Important: globalAssetId EQ-07 does not match a specificAssetId EQ-07', async () => {
    const { call } = await twoAssets();
    const result = await call('/api/v3.0/lookup/shells', query({ name: 'globalAssetId', value: 'EQ-07' }));
    expect(result.body.result).toEqual(['urn:test:aas:eq07']);
  });

  it('a specificAssetId query matches only that name — not the globalAssetId with the same value', async () => {
    const { call } = await twoAssets();
    const result = await call('/api/v3.0/lookup/shells', query({ name: 'SerialNumber', value: 'EQ-07' }));
    expect(result.body.result).toEqual([AAS_ID]);
    const wrongName = await call('/api/v3.0/lookup/shells', query({ name: 'equipmentCode', value: 'EQ-07' }));
    expect(wrongName.body.result).toEqual([]);
  });
});

describe('Important: registration and reality do not diverge', () => {
  it('deleting a file removes it from the registry — because registrations are derived, not accepted', async () => {
    const { store, packageId, call } = await seeded();
    expect((await call('/api/v3.0/shell-descriptors')).body.result).toHaveLength(1);

    await store.deletePackage(packageId);

    expect((await call('/api/v3.0/shell-descriptors')).body.result).toHaveLength(0);
    expect((await call('/api/v3.0/lookup/shells')).body.result).toEqual([]);
  });
});

describe('Important: when the same AAS id is in two files', () => {
  /**
   * Uploading the same file twice produces this right away. If the registry holds the same id twice,
   * the lookup side cannot tell which one to use.
   */
  async function twice() {
    const store = new InMemoryStore();
    await store.init();
    const first = await store.importPackage({ name: '01.aasx', package: readAasx(goldenBytes) });
    const second = await store.importPackage({ name: '01-사본.aasx', package: readAasx(goldenBytes) });
    const handle = createApi(store, { publicBaseUrl: 'https://factory.example.com' });
    const call = async (path: string, query: Record<string, string> = {}) => {
      const response = await handle({ method: 'GET', path, query, headers: {} } as ApiRequest);
      return { status: response.status, body: response.body as any };
    };
    return { first: first.id, second: second.id, call };
  }

  it('the standard response returns only one', async () => {
    const { call } = await twice();
    const result = await call('/api/v3.0/shell-descriptors');
    expect(result.body.result).toHaveLength(1);
  });

  it('lookup by asset number also returns only one — the same id appearing four times is unusable', async () => {
    const { call } = await twice();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }));
    expect((await call('/api/v3.0/lookup/shells', { assetIds })).body.result).toEqual([AAS_ID]);
  });

  it('reports the overlap separately — does not silently hide it', async () => {
    const { call, first, second } = await twice();
    const result = await call('/registry-conflicts');
    expect(result.body.conflicts).toHaveLength(1);
    expect(result.body.conflicts[0].id).toBe(AAS_ID);
    expect(result.body.conflicts[0].packages.sort()).toEqual([first, second].sort());
    expect(result.body.conflicts[0].serving).toBeTruthy();
  });

  it('empty list when there is no overlap', async () => {
    const { call } = await seeded();
    expect((await call('/registry-conflicts')).body.conflicts).toEqual([]);
  });
});
