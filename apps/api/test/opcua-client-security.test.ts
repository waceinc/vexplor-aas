/**
 * OPC UA security on the collecting side (plan gap 2): the settings the server's own collector reads, and what the
 * edge read list hands out from an AID 1.1 interface. The reader itself is tested against a secure server in
 * packages/opcua/test/reader-security.test.ts.
 */
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';
import { interfacesOf } from '../src/edge/read-list.js';
import { opcuaClientPkiDirFromEnv, opcuaClientTrustsFirstUse, parseOpcUaCredentials } from '../src/integration/opcua-env.js';

const UAV = 'http://opcfoundation.org/UA/WoT-Binding/';
const sem = (iri: string) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: iri }] });
const prop = (idShort: string, value: string, iri?: string) => ({ modelType: 'Property', idShort, valueType: 'xs:string', value, ...(iri ? { semanticId: sem(iri) } : {}) });
const smc = (idShort: string, value: unknown[], iri?: string) => ({ modelType: 'SubmodelElementCollection', idShort, value, ...(iri ? { semanticId: sem(iri) } : {}) });
const ref = (name: string) => ({
  modelType: 'ReferenceElement',
  value: { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:aid' }, { type: 'SubmodelElementCollection', value: name }] },
});

function environment(security: unknown[]): Environment {
  return {
    assetAdministrationShells: [{ modelType: 'AssetAdministrationShell', id: 'urn:aas', idShort: 'M', assetInformation: { assetKind: 'Instance', globalAssetId: 'urn:asset' } }],
    submodels: [
      {
        modelType: 'Submodel',
        id: 'urn:aid',
        idShort: 'AssetInterfacesDescription',
        semanticId: sem('https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel'),
        submodelElements: [
          smc('InterfaceOPCUA', [
            smc('EndpointMetadata', [prop('base', 'opc.tcp://10.0.0.5:4840'), ...security]),
            smc('InteractionMetadata', [smc('properties', [smc('Speed', [smc('forms', [prop('href', 'ns=2;s=Speed')])])])]),
          ]),
        ],
      },
    ],
  } as unknown as Environment;
}

describe('edge read list — OPC UA security from the AID', () => {
  it('hands out mode and policy, and names the endpoint as credential when a user name is required', () => {
    const [iface] = interfacesOf(
      'pkg_1',
      environment([
        { modelType: 'SubmodelElementList', idShort: 'security', value: [ref('combo_sc')] },
        smc('securityDefinitions', [
          smc('opcua_channel_sc', [prop('uav_securityMode', 'SignAndEncrypt', `${UAV}securityMode`), prop('uav_securityPolicy', 'Basic256Sha256', `${UAV}securityPolicy`)], `${UAV}OPCUASecurityChannelScheme`),
          smc('opcua_authentication_sc', [prop('uav_userIdentityToken', 'UserName', `${UAV}userIdentityToken`)], `${UAV}OPCUASecurityAuthenticationScheme`),
          smc('combo_sc', [{ modelType: 'SubmodelElementList', idShort: 'allOf', value: [ref('opcua_channel_sc'), ref('opcua_authentication_sc')] }]),
        ]),
      ]),
      1000,
    );
    expect(iface!.security).toEqual({ mode: 'SignAndEncrypt', policy: 'Basic256Sha256', credentialRef: 'opc.tcp://10.0.0.5:4840' });
  });

  it('stays None without stated security (AID 1.0)', () => {
    expect(interfacesOf('pkg_1', environment([]), 1000)[0]!.security).toEqual({ mode: 'None' });
  });
});

describe('collector OPC UA settings', () => {
  it('certificate folder: explicit, else under the data folder, else beside the server; empty means unset', () => {
    expect(opcuaClientPkiDirFromEnv({ OPCUA_CLIENT_PKI_DIR: '/srv/pki' })).toBe('/srv/pki');
    expect(opcuaClientPkiDirFromEnv({ OPCUA_CLIENT_PKI_DIR: '', AAS_DATA_DIR: '/data' })).toBe('/data/opcua-client-pki');
    expect(opcuaClientPkiDirFromEnv({})).toBe('opcua-client-pki');
  });

  it('trusts a new server certificate only when told first-use', () => {
    expect(opcuaClientTrustsFirstUse({})).toBe(false);
    expect(opcuaClientTrustsFirstUse({ OPCUA_CLIENT_TRUST: 'on' })).toBe(false);
    expect(opcuaClientTrustsFirstUse({ OPCUA_CLIENT_TRUST: 'first-use' })).toBe(true);
  });

  it('reads credentials by endpoint and refuses an entry that is not a pair of strings', () => {
    const credentials = parseOpcUaCredentials('{"opc.tcp://10.0.0.5:4840":{"userName":"op","password":"pw"}}');
    expect(credentials.get('opc.tcp://10.0.0.5:4840')).toEqual({ userName: 'op', password: 'pw' });
    expect(() => parseOpcUaCredentials('{"opc.tcp://x":{"userName":"op"}}')).toThrow(/opc\.tcp:\/\/x/);
    expect(() => parseOpcUaCredentials('[]')).toThrow();
  });
});
