/**
 * AAS Registry & Discovery.
 *
 * 🔴 이 시험의 요점: **자산 번호로 AAS를 찾을 수 있는가.**
 * 현장 시스템은 AAS id를 모른다 — 설비 번호·일련번호를 들고 온다.
 *
 * 🔴 그리고 **등록과 실제가 어긋나지 않는가.** 우리는 등록을 받지 않고 파생시키므로
 *    파일을 지우면 레지스트리에서도 즉시 사라져야 한다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));
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

describe('AAS 레지스트리', () => {
  it('가진 AAS를 서술자로 알려 준다', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    expect(result.status).toBe(200);
    expect(result.body.result).toHaveLength(1);
    expect(result.body.result[0].id).toBe(AAS_ID);
    expect(result.body.result[0].idShort).toBe('RollFormingMachine');
  });

  it('🔴 찾아올 주소를 함께 준다 — 이게 레지스트리의 전부다', async () => {
    const { call, packageId } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    const endpoint = result.body.result[0].endpoints[0];
    expect(endpoint.interface).toBe('AAS-3.0');
    expect(endpoint.protocolInformation.href).toBe(
      `https://factory.example.com/packages/${packageId}/api/v3.0/shells/${encode(AAS_ID)}`,
    );
  });

  it('서브모델 서술자가 딸려 온다 (각자 제 주소를 갖는다)', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/shell-descriptors');
    const submodels = result.body.result[0].submodelDescriptors;
    expect(submodels.length).toBe(7);
    expect(submodels[0].endpoints[0].interface).toBe('SUBMODEL-3.0');
    expect(submodels[0].endpoints[0].protocolInformation.href).toContain('/submodels/');
  });

  it('id로 하나만 집을 수 있다', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/shell-descriptors/${encode(AAS_ID)}`);
    expect(result.status).toBe(200);
    expect(result.body.id).toBe(AAS_ID);
  });

  it('없는 id는 404 — 있는 척하지 않는다', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/shell-descriptors/${encode('https://example.com/없음')}`);
    expect(result.status).toBe(404);
  });

  it('서브모델만 따로 찾을 수도 있다', async () => {
    const { call } = await seeded();
    const all = await call('/api/v3.0/submodel-descriptors');
    expect(all.body.result.length).toBe(7);
    const one = await call(
      `/api/v3.0/submodel-descriptors/${encode('https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1')}`,
    );
    expect(one.body.idShort).toBe('DigitalNameplate');
  });

  it('assetKind로 거를 수 있다 (본 사업 산출물은 Type이다)', async () => {
    const { call } = await seeded();
    expect((await call('/api/v3.0/shell-descriptors', { assetKind: 'Type' })).body.result).toHaveLength(1);
    expect((await call('/api/v3.0/shell-descriptors', { assetKind: 'Instance' })).body.result).toHaveLength(0);
  });
});

describe('디스커버리 — 자산 번호로 AAS 찾기', () => {
  it('🔴 globalAssetId로 AAS를 찾는다 — 현장은 AAS id를 모른다', async () => {
    const { call } = await seeded();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }));
    const result = await call('/api/v3.0/lookup/shells', { assetIds });
    expect(result.body.result).toEqual([AAS_ID]);
  });

  it('없는 자산이면 빈 목록 (404가 아니다 — 찾은 게 없을 뿐이다)', async () => {
    const { call } = await seeded();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: 'urn:없는자산' }));
    const result = await call('/api/v3.0/lookup/shells', { assetIds });
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual([]);
  });

  it('날것 JSON으로 물어봐도 받아 준다 — 그렇게 보내는 구현이 흔하다', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/lookup/shells', {
      assetIds: JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }),
    });
    expect(result.body.result).toEqual([AAS_ID]);
  });

  it('AAS가 가진 자산 식별자를 되돌려 준다', async () => {
    const { call } = await seeded();
    const result = await call(`/api/v3.0/lookup/shells/${encode(AAS_ID)}`);
    expect(result.body).toEqual([{ name: 'globalAssetId', value: ASSET_ID }]);
  });

  it('아무 조건 없이 물으면 전부 준다', async () => {
    const { call } = await seeded();
    const result = await call('/api/v3.0/lookup/shells');
    expect(result.body.result).toEqual([AAS_ID]);
  });
});

describe('🔴 등록과 실제가 어긋나지 않는다', () => {
  it('파일을 지우면 레지스트리에서도 사라진다 — 등록을 받지 않고 파생시키기 때문이다', async () => {
    const { store, packageId, call } = await seeded();
    expect((await call('/api/v3.0/shell-descriptors')).body.result).toHaveLength(1);

    await store.deletePackage(packageId);

    expect((await call('/api/v3.0/shell-descriptors')).body.result).toHaveLength(0);
    expect((await call('/api/v3.0/lookup/shells')).body.result).toEqual([]);
  });
});

describe('🔴 같은 AAS id가 두 파일에 있을 때', () => {
  /**
   * 같은 파일을 두 번 올리면 바로 생긴다. 레지스트리에서 같은 id가 둘이면
   * 찾는 쪽이 어느 것을 써야 할지 알 수 없다.
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

  it('표준 응답에는 하나만 나간다', async () => {
    const { call } = await twice();
    const result = await call('/api/v3.0/shell-descriptors');
    expect(result.body.result).toHaveLength(1);
  });

  it('자산 번호로 찾아도 하나만 나온다 — 같은 id가 네 번 나오면 쓸 수 없다', async () => {
    const { call } = await twice();
    const assetIds = encode(JSON.stringify({ name: 'globalAssetId', value: ASSET_ID }));
    expect((await call('/api/v3.0/lookup/shells', { assetIds })).body.result).toEqual([AAS_ID]);
  });

  it('겹쳤다는 사실은 따로 알려 준다 — 조용히 감추지 않는다', async () => {
    const { call, first, second } = await twice();
    const result = await call('/registry-conflicts');
    expect(result.body.conflicts).toHaveLength(1);
    expect(result.body.conflicts[0].id).toBe(AAS_ID);
    expect(result.body.conflicts[0].packages.sort()).toEqual([first, second].sort());
    expect(result.body.conflicts[0].serving).toBeTruthy();
  });

  it('겹치지 않으면 빈 목록', async () => {
    const { call } = await seeded();
    expect((await call('/registry-conflicts')).body.conflicts).toEqual([]);
  });
});
