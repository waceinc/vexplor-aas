/**
 * AID 해석 검증.
 *
 * 시험용 AID는 IDTA-02017-1-0 공식 템플릿의 구조를 그대로 따랐다
 * (EndpointMetadata.base · InteractionMetadata.properties.<이름>.forms.href).
 * OPC UA 인터페이스는 AID 1.1이 더하는 것이라 같은 뼈대에 프로토콜 항목만 얹어 만들었다.
 */
import type { Environment } from '@aas/core';
import { findAidSubmodels, parseAid, protocolOf, readableProperties } from '@aas/collector';
import { describe, expect, it } from 'vitest';

/** SMC 만들기 도우미 — 시험이 구조를 그대로 드러내도록 */
const smc = (idShort: string, value: unknown[]): Record<string, unknown> => ({
  modelType: 'SubmodelElementCollection',
  idShort,
  value,
});
const prop = (idShort: string, value: string): Record<string, unknown> => ({
  modelType: 'Property',
  idShort,
  valueType: 'xs:string',
  value,
});

const environment = {
  submodels: [
    {
      modelType: 'Submodel',
      id: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
      idShort: 'AssetInterfacesDescription',
      kind: 'Template',
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
          prop('title', '롤포밍기 OPC UA'),
          smc('EndpointMetadata', [
            prop('base', 'opc.tcp://192.168.0.10:4840'),
            prop('contentType', 'application/json'),
          ]),
          smc('InteractionMetadata', [
            smc('properties', [
              smc('MotorSpeed', [
                prop('key', 'D100'),
                prop('type', 'float'),
                prop('unit', 'rpm'),
                prop('observable', 'true'),
                smc('forms', [
                  prop('href', 'ns=2;s=Machine.MotorSpeed'),
                  prop('contentType', 'application/json'),
                  prop('opc_samplingInterval', '1000'),
                ]),
              ]),
              smc('AlarmActive', [
                prop('key', 'M20'),
                prop('type', 'boolean'),
                prop('observable', 'false'),
                smc('forms', [prop('href', 'ns=2;s=Machine.AlarmActive')]),
              ]),
              // 주소가 없는 항목 — 수집 대상이 아니다
              smc('설명만있는것', [prop('type', 'string')]),
            ]),
          ]),
        ]),
        smc('InterfaceTemplateForHTTP', [
          smc('EndpointMetadata', [prop('base', 'http://192.168.0.20/api')]),
          smc('InteractionMetadata', [
            smc('properties', [
              smc('Voltage', [
                prop('type', 'float'),
                smc('forms', [
                  prop('href', '/sampleDevice/properties/voltage'),
                  prop('htv_methodName', 'GET'),
                ]),
              ]),
            ]),
          ]),
        ]),
      ],
    },
  ],
} as unknown as Environment;

describe('AID 서브모델 찾기', () => {
  it('semanticId로 찾는다 — 버전이 1.0이든 1.1이든', () => {
    expect(findAidSubmodels(environment)).toHaveLength(1);
  });

  it('🔴 이관된 AID도 찾는다 — KOSMO 제출본에서는 semanticId가 자체 IRI로 바뀐다', () => {
    // AID의 표준 semanticId는 admin-shell.io IRI인데 KOSMO는 화이트리스트 밖이라 거부한다.
    // 「고치기」가 자기 id로 옮기면(이관 대장에 원본을 남기고) semanticId로는 못 찾게 되므로
    // idShort가 유일한 근거가 된다. 수집이 제출본에서도 살아 있으려면 이걸 반드시 지켜야 한다
    const relocated = JSON.parse(JSON.stringify(environment)) as Environment;
    const submodel = relocated.submodels![0]!;
    submodel.semanticId = {
      type: 'ExternalReference',
      keys: [{ type: 'GlobalReference', value: submodel.id }],
    };

    expect(findAidSubmodels(relocated)).toHaveLength(1);
    expect(parseAid(relocated)).toHaveLength(2);
  });

  it('AID가 없는 파일에서는 빈 목록', () => {
    const plain = { submodels: [{ modelType: 'Submodel', id: 'x', idShort: 'TechnicalData' }] };
    expect(findAidSubmodels(plain as unknown as Environment)).toHaveLength(0);
    expect(parseAid(plain as unknown as Environment)).toHaveLength(0);
  });
});

describe('AID 해석', () => {
  const interfaces = parseAid(environment);

  it('인터페이스마다 프로토콜과 접속 주소를 뽑는다', () => {
    expect(interfaces.map((i) => [i.name, i.protocol, i.base])).toEqual([
      ['InterfaceTemplateForOPCUA', 'OPCUA', 'opc.tcp://192.168.0.10:4840'],
      ['InterfaceTemplateForHTTP', 'HTTP', 'http://192.168.0.20/api'],
    ]);
  });

  it('프로토콜은 이름과 접속 주소 양쪽으로 알아본다', () => {
    expect(protocolOf('InterfaceTemplateForOPCUA')).toBe('OPCUA');
    expect(protocolOf('무명인터페이스', 'opc.tcp://x')).toBe('OPCUA');
    expect(protocolOf('무명인터페이스', 'modbus+tcp://x')).toBe('MODBUS');
    expect(protocolOf('무명인터페이스')).toBe('UNKNOWN');
  });

  it('property의 주소·타입·단위·관측 가능 여부를 읽는다', () => {
    const opcua = interfaces[0]!;
    const speed = opcua.properties.find((p) => p.name === 'MotorSpeed')!;
    expect(speed).toMatchObject({
      key: 'D100',
      type: 'float',
      unit: 'rpm',
      observable: true,
      href: 'ns=2;s=Machine.MotorSpeed',
    });
  });

  it('forms의 프로토콜 고유 항목은 이름을 가리지 않고 그대로 담는다', () => {
    // AID 1.1의 OPC UA 용어가 확정되면 이 자리를 읽는다
    const speed = interfaces[0]!.properties.find((p) => p.name === 'MotorSpeed')!;
    expect(speed.formFields).toEqual({
      contentType: 'application/json',
      opc_samplingInterval: '1000',
    });
    const voltage = interfaces[1]!.properties.find((p) => p.name === 'Voltage')!;
    expect(voltage.formFields['htv_methodName']).toBe('GET');
  });

  it('주소가 없는 항목은 수집 대상에서 뺀다 — 읽을 곳이 없다', () => {
    const opcua = interfaces[0]!;
    expect(opcua.properties.map((p) => p.name)).toContain('설명만있는것');
    expect(readableProperties(opcua).map((p) => p.name)).toEqual(['MotorSpeed', 'AlarmActive']);
  });
});
