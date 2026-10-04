/**
 * 수집 경로 검증 (M8) — 가짜 어댑터로.
 *
 * 실제 OPC UA 왕복은 packages/opcua의 내장 서버 시험이 맡는다.
 * 여기서 볼 것은 **API의 계약**이다: 인터페이스 노출 · 수집 실행 · 시계열 조회 ·
 * 어댑터가 없는 배포에서의 응답.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { canonicalJson } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

const smc = (idShort: string, value: unknown[]): unknown => ({
  modelType: 'SubmodelElementCollection',
  idShort,
  value,
});
const prop = (idShort: string, value: string): unknown => ({
  modelType: 'Property',
  idShort,
  valueType: 'xs:string',
  value,
});

/** AID 서브모델을 얹은 패키지를 만든다 */
async function seeded(options: { withAid?: boolean; reader?: boolean } = {}) {
  const store = new InMemoryStore();
  await store.init();
  const pkg = readAasx(goldenBytes);

  if (options.withAid !== false) {
    pkg.environment.submodels!.push({
      modelType: 'Submodel',
      id: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
      idShort: 'AssetInterfacesDescription',
      kind: 'Template',
      administration: { version: '1', revision: '0' },
      semanticId: {
        type: 'ExternalReference',
        keys: [
          {
            type: 'GlobalReference',
            value: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/1/Submodel',
          },
        ],
      },
      submodelElements: [
        smc('InterfaceTemplateForOPCUA', [
          smc('EndpointMetadata', [prop('base', 'opc.tcp://192.168.0.10:4840')]),
          smc('InteractionMetadata', [
            smc('properties', [
              smc('MotorSpeed', [
                prop('unit', 'rpm'),
                smc('forms', [prop('href', 'ns=1;s=Speed')]),
              ]),
            ]),
          ]),
        ]),
      ],
    } as never);
  }

  const record = await store.importPackage({ name: '01.aasx', package: pkg });

  const openReader = async (descriptor: AidInterface): Promise<ProtocolReader> => ({
    base: descriptor.base!,
    read: async (sources) =>
      sources.map((source) => ({ source, value: 1234.5, quality: 'Good', observedAt: '2026-08-24T00:00:00.000Z' })),
    close: async () => {},
  });

  const handle = createApi(store, options.reader === false ? {} : { openReader });
  const call = async (
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    const response = await handle({
      method,
      path,
      query: init.query ?? {},
      headers: {},
      ...(init.body === undefined ? {} : { body: init.body }),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };

  return { store, packageId: record.id, call };
}

describe('수집 경로 (M8)', () => {
  it('AID가 기술한 인터페이스를 알려 준다 — 출처는 파일 안의 AID다', async () => {
    const { packageId, call } = await seeded();
    const result = await call('GET', `/packages/${packageId}/interfaces`);

    expect(result.status).toBe(200);
    expect(result.body.source).toBe('AssetInterfacesDescription');
    expect(result.body.interfaces).toHaveLength(1);
    expect(result.body.interfaces[0]).toMatchObject({
      name: 'InterfaceTemplateForOPCUA',
      protocol: 'OPCUA',
      base: 'opc.tcp://192.168.0.10:4840',
    });
    expect(result.body.interfaces[0].properties[0]).toMatchObject({
      name: 'MotorSpeed',
      unit: 'rpm',
      href: 'ns=1;s=Speed',
    });
  });

  it('수집하면 시계열에 쌓이고 모델은 그대로다 (A안)', async () => {
    const { store, packageId, call } = await seeded();
    const before = canonicalJson(await store.getEnvironment(packageId));

    const cycle = await call('POST', `/packages/${packageId}/collect`);
    expect(cycle.status).toBe(200);
    expect(cycle.body.collected).toBe(1);
    expect(cycle.body.interfaces[0].report.failures).toEqual([]);

    const values = await call('GET', `/packages/${packageId}/values`);
    expect(values.body.result).toHaveLength(1);
    expect(values.body.result[0]).toMatchObject({
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MotorSpeed',
      source: 'ns=1;s=Speed',
      valueNumber: 1234.5,
      quality: 'Good',
    });

    // 🔴 수집은 편집이 아니다
    expect(canonicalJson(await store.getEnvironment(packageId))).toBe(before);
  });

  it('조회를 좁힐 수 있다 — 이름·기간·개수', async () => {
    const { packageId, call } = await seeded();
    await call('POST', `/packages/${packageId}/collect`);

    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { property: 'MotorSpeed' } })).body
        .result,
    ).toHaveLength(1);
    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { property: '없는것' } })).body.result,
    ).toHaveLength(0);
    expect(
      (await call('GET', `/packages/${packageId}/values`, { query: { from: '2027-01-01T00:00:00Z' } }))
        .body.result,
    ).toHaveLength(0);

    const bad = await call('GET', `/packages/${packageId}/values`, { query: { limit: '많이' } });
    expect(bad.status).toBe(400);
  });

  it('AID가 없으면 수집할 주소를 알 수 없다고 답한다', async () => {
    const { packageId, call } = await seeded({ withAid: false });
    const result = await call('POST', `/packages/${packageId}/collect`);
    expect(result.status).toBe(404);
    expect(result.body.messages[0].text).toContain('AssetInterfacesDescription');
  });

  it('수집 어댑터가 없는 배포에서는 501 — 저작만 하는 서버도 있다', async () => {
    const { packageId, call } = await seeded({ reader: false });
    const result = await call('POST', `/packages/${packageId}/collect`);
    expect(result.status).toBe(501);
    expect(result.body.messages[0].code).toBe('NotImplemented');
  });
});

describe('🔴 수집값 읽기 전용 덧씌우기 (BaSyx DataBridge 동등)', () => {
  /**
   * BaSyx는 DataBridge가 값을 Submodel에 반영해 다른 시스템이 표준 API로 현재값을 본다.
   * 우리는 A안(파일이 원본)이라 시계열에만 쌓는다 —
   * `live=true`일 때만 **응답에** 얹어 같은 겉모습을 만든다. 파일은 그대로다.
   */
  const seedValue = async (store: Awaited<ReturnType<typeof seeded>>['store'], packageId: string) => {
    await store.appendValues(packageId, [
      {
        packageId,
        interfaceName: 'InterfaceTemplateForOPCUA',
        propertyName: 'SerialNumber',
        observedAt: '2026-08-25T00:00:00.000Z',
        valueText: '현장에서-읽은-값',
        quality: 'Good',
      },
    ]);
  };

  const nameplateId =
    'https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1';
  const encoded = Buffer.from(nameplateId).toString('base64url');

  it('기본은 파일 값 그대로다 — 아무 표시 없이 섞이면 안 된다', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
    );
    expect(result.status).toBe(200);
    expect(result.body.value).toBe('EXM-RFL-2026-00127');
  });

  it('live=true면 현장 값이 보인다', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
      { query: { live: 'true' } },
    );
    expect(result.body.value).toBe('현장에서-읽은-값');
  });

  it('$value에도 얹힌다 — 외부 시스템이 실제로 읽는 자리다', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    const result = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber/$value`,
      { query: { live: 'true' } },
    );
    expect(JSON.stringify(result.body)).toContain('현장에서-읽은-값');
  });

  it('🔴 파일은 그대로다 — 덧씌워도 저장된 내용이 바뀌지 않는다', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);
    const before = canonicalJson(await store.getEnvironment(packageId));

    await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      query: { live: 'true' },
    });

    expect(canonicalJson(await store.getEnvironment(packageId))).toBe(before);
  });

  it('🔴 덧씌운 값을 저장하지 않는다 — 편집은 언제나 파일 값을 바탕으로 한다', async () => {
    const { store, packageId, call } = await seeded();
    await seedValue(store, packageId);

    // live로 읽은 뒤 다른 요소를 고쳐도 SerialNumber는 파일 값이어야 한다
    await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      query: { live: 'true' },
    });
    await call(
      'PATCH',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/YearOfConstruction/$value`,
      { body: '2027' },
    );

    const after = await call(
      'GET',
      `/packages/${packageId}/api/v3.0/submodels/${encoded}/submodel-elements/SerialNumber`,
    );
    expect(after.body.value).toBe('EXM-RFL-2026-00127');
  });
});
