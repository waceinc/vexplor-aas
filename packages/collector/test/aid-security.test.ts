/**
 * OPC UA security from an AID 1.1 interface (IDTA-02017 1.1 §2.25, §2.27.7 – 2.27.9): EndpointMetadata holds a
 * `security` list of references into `securityDefinitions`; an OPC UA channel scheme carries `uav_securityMode` and
 * `uav_securityPolicy`, an authentication scheme `uav_userIdentityToken`, and a combo scheme joins them with `allOf`.
 * Schemes and terms are found by semanticId; idShorts are only the fallback.
 */
import type { Submodel } from '@aas/core';
import { describe, expect, it } from 'vitest';
import { parseAidSubmodel } from '../src/aid.js';

const UAV = 'http://opcfoundation.org/UA/WoT-Binding/';
const sem = (iri: string) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: iri }] });
const prop = (idShort: string, value: string, iri?: string) => ({ modelType: 'Property', idShort, valueType: 'xs:string', value, ...(iri ? { semanticId: sem(iri) } : {}) });
const smc = (idShort: string, value: unknown[], iri?: string) => ({ modelType: 'SubmodelElementCollection', idShort, value, ...(iri ? { semanticId: sem(iri) } : {}) });
const ref = (...path: string[]) => ({
  modelType: 'ReferenceElement',
  value: { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:aid' }, ...path.map((value) => ({ type: 'SubmodelElementCollection', value }))] },
});
const list = (idShort: string, value: unknown[]) => ({ modelType: 'SubmodelElementList', idShort, typeValueListElement: 'ReferenceElement', value });

function aid(endpointExtra: unknown[]): Submodel {
  return {
    modelType: 'Submodel',
    id: 'urn:aid',
    idShort: 'AssetInterfacesDescription',
    submodelElements: [
      smc('InterfaceOPCUA', [
        smc('EndpointMetadata', [prop('base', 'opc.tcp://10.0.0.5:4840'), ...endpointExtra]),
        smc('InteractionMetadata', [smc('properties', [smc('Speed', [smc('forms', [prop('href', 'ns=2;s=Speed')])])])]),
      ]),
    ],
  } as unknown as Submodel;
}

const base = ['InterfaceOPCUA', 'EndpointMetadata', 'securityDefinitions'];

describe('AID OPC UA security', () => {
  it('reads a combo of channel and authentication schemes, by semanticId', () => {
    const [iface] = parseAidSubmodel(
      aid([
        list('security', [ref(...base, 'secure')]),
        smc('securityDefinitions', [
          smc('chan', [prop('m', 'SignAndEncrypt', `${UAV}securityMode`), prop('p', 'Aes256_Sha256_RsaPss', `${UAV}securityPolicy`)], `${UAV}OPCUASecurityChannelScheme`),
          smc('auth', [prop('u', 'UserName', `${UAV}userIdentityToken`)], `${UAV}OPCUASecurityAuthenticationScheme`),
          smc('secure', [list('allOf', [ref(...base, 'chan'), ref(...base, 'auth')])]),
        ]),
      ]),
    );
    expect(iface!.security).toEqual({ mode: 'SignAndEncrypt', policy: 'Aes256_Sha256_RsaPss', userIdentityToken: 'UserName' });
  });

  it('falls back to the idShorts of the specification', () => {
    const [iface] = parseAidSubmodel(
      aid([
        list('security', [ref(...base, 'opcua_channel_sc')]),
        smc('securityDefinitions', [smc('opcua_channel_sc', [prop('uav_securityMode', 'Sign'), prop('uav_securityPolicy', 'Basic256Sha256')])]),
      ]),
    );
    expect(iface!.security).toEqual({ mode: 'Sign', policy: 'Basic256Sha256' });
  });

  it('applies only schemes the security list names', () => {
    const [iface] = parseAidSubmodel(
      aid([
        list('security', [ref(...base, 'nosec_sc')]),
        smc('securityDefinitions', [smc('nosec_sc', []), smc('opcua_channel_sc', [prop('uav_securityMode', 'Sign'), prop('uav_securityPolicy', 'Basic256Sha256')])]),
      ]),
    );
    expect(iface!.security).toBeUndefined();
  });

  it('leaves security out when the interface states none (AID 1.0 files)', () => {
    expect(parseAidSubmodel(aid([]))[0]!.security).toBeUndefined();
  });

  it('ignores a mode outside the binding and a reference loop', () => {
    const [iface] = parseAidSubmodel(
      aid([
        list('security', [ref(...base, 'loop')]),
        smc('securityDefinitions', [
          smc('loop', [list('allOf', [ref(...base, 'loop'), ref(...base, 'opcua_channel_sc')])]),
          smc('opcua_channel_sc', [prop('uav_securityMode', 'Plaintext'), prop('uav_securityPolicy', 'Basic256Sha256')]),
        ]),
      ]),
    );
    expect(iface!.security).toEqual({ policy: 'Basic256Sha256' });
  });
});
