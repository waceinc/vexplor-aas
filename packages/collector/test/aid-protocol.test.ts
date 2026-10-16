/**
 * The protocol of an AID interface (plan gap 3): AID 1.1 states it by the interface's supplementalSemanticId
 * (IDTA-02017 1.1 Table 3 — modbus, mqtt, http, bacnet, OPC UA WoT binding). The idShort is only a convention
 * ("Interface00" is as valid as "InterfaceOPCUA"), so it is the last resort, after the endpoint scheme.
 */
import type { Submodel } from '@aas/core';
import { describe, expect, it } from 'vitest';
import { parseAidSubmodel } from '../src/aid.js';

const sem = (iri: string) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: iri }] });
const prop = (idShort: string, value: string) => ({ modelType: 'Property', idShort, valueType: 'xs:string', value });

function aid(idShort: string, base: string, supplemental?: string): Submodel {
  return {
    modelType: 'Submodel',
    id: 'urn:aid',
    idShort: 'AssetInterfacesDescription',
    submodelElements: [
      {
        modelType: 'SubmodelElementCollection',
        idShort,
        semanticId: sem('https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Interface'),
        ...(supplemental ? { supplementalSemanticIds: [sem(supplemental), sem('https://www.w3.org/2019/wot/td')] } : {}),
        value: [
          { modelType: 'SubmodelElementCollection', idShort: 'EndpointMetadata', value: [prop('base', base)] },
          { modelType: 'SubmodelElementCollection', idShort: 'InteractionMetadata', value: [] },
        ],
      },
    ],
  } as unknown as Submodel;
}

const protocol = (idShort: string, base: string, supplemental?: string) => parseAidSubmodel(aid(idShort, base, supplemental))[0]!.protocol;

describe('AID interface protocol', () => {
  it('takes the supplementalSemanticId over a misleading idShort', () => {
    expect(protocol('InterfaceOPCUA', 'mqtt://broker:1883', 'http://www.w3.org/2011/mqtt')).toBe('MQTT');
    expect(protocol('InterfaceHTTP', 'tcp://10.0.0.6:502', 'http://www.w3.org/2011/modbus')).toBe('MODBUS');
    expect(protocol('Interface_MQTT', 'opc.tcp://10.0.0.5:4840', 'http://opcfoundation.org/UA/WoT-Binding/')).toBe('OPCUA');
    expect(protocol('Interface00', 'mqtts://broker:8883', 'http://www.w3.org/2011/mqtt')).toBe('MQTT');
    expect(protocol('Interface01', 'https://device/api', 'http://www.w3.org/2011/http')).toBe('HTTP');
  });

  it('recognises BACnet as its own protocol instead of guessing from the name', () => {
    expect(protocol('InterfaceHTTP', 'bacnet://10.0.0.7', 'http://www.w3.org/2022/bacnet')).toBe('BACNET');
  });

  it('without a supplementalSemanticId, the endpoint scheme decides before the name', () => {
    expect(protocol('InterfaceMQTT', 'opc.tcp://10.0.0.5:4840')).toBe('OPCUA');
    expect(protocol('InterfaceOPCUA', 'opc.tcp://10.0.0.5:4840')).toBe('OPCUA');
    expect(protocol('InterfaceModbus', '')).toBe('MODBUS');
    expect(protocol('Interface00', 'ftp://x')).toBe('UNKNOWN');
  });
});
