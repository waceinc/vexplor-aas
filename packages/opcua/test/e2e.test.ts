/**
 * M8 전 과정 — AID → OPC UA → 수집 → 시계열.
 *
 * 실물 PLC 없이 **진짜 프로토콜**로 한 줄을 꿴다. 조각마다 통과해도 이어 붙이면 어긋나는 일이
 * 흔해서, 이 시험이 M8의 실질 검수 기준이다.
 *
 * 함께 확인하는 것: 🔴 **수집해도 모델은 그대로다**(값 동기화 A안).
 */
import { readAasx } from '@aas/aasx';
import { canonicalJson, type Environment } from '@aas/core';
import { collectOnce, parseAid } from '@aas/collector';
import { OpcUaReader } from '@aas/opcua';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let server: TestServer;

beforeAll(async () => {
  try {
    server = await startTestServer(14850);
  } catch {
    server = await startTestServer(14851);
  }
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

/** 골든 파일에 AID 서브모델을 얹는다 — 실제 장비 파일에 인터페이스를 기술한 모습 */
function withAid(environment: Environment, endpoint: string): Environment {
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

  const aid = {
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
        prop('title', '롤포밍기 제어반'),
        smc('EndpointMetadata', [prop('base', endpoint)]),
        smc('InteractionMetadata', [
          smc('properties', [
            smc('MotorSpeed', [
              prop('key', 'D100'),
              prop('type', 'float'),
              prop('unit', 'rpm'),
              prop('observable', 'true'),
              smc('forms', [prop('href', 'ns=1;s=Machine.MotorSpeed')]),
            ]),
            smc('AlarmActive', [
              prop('type', 'boolean'),
              smc('forms', [prop('href', 'ns=1;s=Machine.AlarmActive')]),
            ]),
            smc('BrokenSensor', [
              prop('type', 'float'),
              smc('forms', [prop('href', 'ns=1;s=Machine.BrokenSensor')]),
            ]),
            // 🔴 아직 값이 안 들어온 태그 — 고장(BrokenSensor)과 갈리는지가 이 시험의 관건
            smc('NotYetReady', [
              prop('type', 'float'),
              smc('forms', [prop('href', 'ns=1;s=Machine.NotYetReady')]),
            ]),
          ]),
        ]),
      ]),
    ],
  };

  return {
    ...environment,
    submodels: [...(environment.submodels ?? []), aid as never],
  };
}

describe('M8 전 과정 (AID → OPC UA → 시계열)', () => {
  it('AID가 말한 주소를 실제로 읽어 시계열에 쌓는다', async () => {
    const pkg = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));
    const environment = withAid(pkg.environment, server.endpoint);

    const store = new InMemoryStore();
    await store.init();
    const record = await store.importPackage({
      name: '01-롤포밍기.aasx',
      package: { ...pkg, environment },
    });

    // ① 파일 안의 AID를 읽는다 — 자체 매핑 테이블이 없다
    const interfaces = parseAid(await store.getEnvironment(record.id));
    expect(interfaces).toHaveLength(1);
    const descriptor = interfaces[0]!;
    expect(descriptor.protocol).toBe('OPCUA');
    expect(descriptor.base).toBe(server.endpoint);

    // ② 그 주소로 실제 접속해 읽는다
    server.setSpeed(1310.75);
    const reader = await OpcUaReader.connect({ endpoint: descriptor.base!, connectTimeoutMs: 5000 });
    const before = canonicalJson(await store.getEnvironment(record.id));

    const report = await collectOnce(
      descriptor,
      reader,
      { append: (samples) => store.appendValues(record.id, samples) },
      { packageId: record.id },
    );
    await reader.close();

    // ③ 정상 태그는 쌓이고, 나쁜 태그는 사유와 함께 남는다
    expect(report.collected).toBe(2);
    expect(report.failures).toEqual([
      expect.objectContaining({ propertyName: 'BrokenSensor', reason: expect.stringContaining('Bad') }),
    ]);

    // ③-2 🔴 아직 값이 없는 태그는 **실패가 아니다** — 따로 센다.
    //     설비가 멀쩡한데 「나쁜 태그」로 세면 초보 사용자가 고장으로 읽는다
    expect(report.pending).toEqual([
      expect.objectContaining({ propertyName: 'NotYetReady', reason: 'BadWaitingForInitialData' }),
    ]);
    // 🔴 그리고 시계열에는 아무것도 넣지 않는다 — 없는 값을 빈 표본으로 위장하면
    //    "그 시각에 관측됐다"는 가짜 이력이 남는다
    expect(await store.readValues(record.id, { propertyName: 'NotYetReady' })).toEqual([]);

    const speed = await store.readValues(record.id, { propertyName: 'MotorSpeed' });
    expect(speed).toHaveLength(1);
    expect(speed[0]!.valueNumber).toBe(1310.75);
    expect(speed[0]!.source).toBe('ns=1;s=Machine.MotorSpeed');
    expect(speed[0]!.quality).toBe('Good');
    // 시각은 장비가 준 것
    expect(new Date(speed[0]!.observedAt).getTime()).toBeGreaterThan(0);

    const alarm = await store.readValues(record.id, { propertyName: 'AlarmActive' });
    expect(alarm[0]!.valueNumber).toBe(0);
    expect(alarm[0]!.valueText).toBe('false');

    // ④ 🔴 A안 — 수집해도 모델은 그대로다
    expect(canonicalJson(await store.getEnvironment(record.id))).toBe(before);
    const shell = (await store.getEnvironment(record.id)).assetAdministrationShells![0]!;
    expect(shell.assetInformation.assetKind).toBe('Type'); // 여전히 Type/Template이다
  }, 60_000);
});
