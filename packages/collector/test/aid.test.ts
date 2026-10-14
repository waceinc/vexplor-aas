/**
 * AID parsing tests.
 *
 * The test AID follows the structure of the official IDTA-02017-1-0 template exactly
 * (EndpointMetadata.base / InteractionMetadata.properties.<name>.forms.href).
 * The OPC UA interface is an AID 1.1 addition, so it reuses the same skeleton with only protocol fields added.
 */
import type { Environment } from '@aas/core';
import { findAidSubmodels, parseAid, protocolOf, readableProperties } from '@aas/collector';
import { describe, expect, it } from 'vitest';

/** SMC builder helper — keeps the structure visible in the tests */
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
              // An item without an address — not a collection target
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

describe('Finding the AID submodel', () => {
  it('finds it by semanticId — whether version 1.0 or 1.1', () => {
    expect(findAidSubmodels(environment)).toHaveLength(1);
  });

  it('also finds a migrated AID — in KOSMO submissions the semanticId becomes our own IRI', () => {
    // The standard AID semanticId is an admin-shell.io IRI, which KOSMO rejects as outside its whitelist.
    // Once "Fix" moves it to our own id (keeping the original in the migration log), it can no longer be found by semanticId,
    // so idShort is the only handle. This must hold for collection to keep working on submitted files
    const relocated = JSON.parse(JSON.stringify(environment)) as Environment;
    const submodel = relocated.submodels![0]!;
    submodel.semanticId = {
      type: 'ExternalReference',
      keys: [{ type: 'GlobalReference', value: submodel.id }],
    };

    expect(findAidSubmodels(relocated)).toHaveLength(1);
    expect(parseAid(relocated)).toHaveLength(2);
  });

  it('returns an empty list for a file without AID', () => {
    const plain = { submodels: [{ modelType: 'Submodel', id: 'x', idShort: 'TechnicalData' }] };
    expect(findAidSubmodels(plain as unknown as Environment)).toHaveLength(0);
    expect(parseAid(plain as unknown as Environment)).toHaveLength(0);
  });
});

describe('AID parsing', () => {
  const interfaces = parseAid(environment);

  it('extracts protocol and endpoint address per interface', () => {
    expect(interfaces.map((i) => [i.name, i.protocol, i.base])).toEqual([
      ['InterfaceTemplateForOPCUA', 'OPCUA', 'opc.tcp://192.168.0.10:4840'],
      ['InterfaceTemplateForHTTP', 'HTTP', 'http://192.168.0.20/api'],
    ]);
  });

  it('detects the protocol from both name and endpoint address', () => {
    expect(protocolOf('InterfaceTemplateForOPCUA')).toBe('OPCUA');
    expect(protocolOf('무명인터페이스', 'opc.tcp://x')).toBe('OPCUA');
    expect(protocolOf('무명인터페이스', 'modbus+tcp://x')).toBe('MODBUS');
    expect(protocolOf('무명인터페이스')).toBe('UNKNOWN');
  });

  it('reads property address, type, unit and observability', () => {
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

  it('keeps protocol-specific forms fields as is, regardless of name', () => {
    // Once AID 1.1 OPC UA terminology is finalized, this is where it is read
    const speed = interfaces[0]!.properties.find((p) => p.name === 'MotorSpeed')!;
    expect(speed.formFields).toEqual({
      contentType: 'application/json',
      opc_samplingInterval: '1000',
    });
    const voltage = interfaces[1]!.properties.find((p) => p.name === 'Voltage')!;
    expect(voltage.formFields['htv_methodName']).toBe('GET');
  });

  it('excludes items without an address from collection — nothing to read', () => {
    const opcua = interfaces[0]!;
    expect(opcua.properties.map((p) => p.name)).toContain('설명만있는것');
    expect(readableProperties(opcua).map((p) => p.name)).toEqual(['MotorSpeed', 'AlarmActive']);
  });
});
