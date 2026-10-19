/**
 * Building an AID for S7 and MC — VEXPLOR extension bindings (plc-address.ts).
 *
 * Important: the same round trip as the other protocols — `parseAid()` must read back the protocol and the addresses,
 *    and the builder must refuse an address the reader would refuse. The interface states our binding IRI, so the
 *    extension is visible in the file itself and a reader that does not know it is never misled.
 */
import { AidBuildError, BINDING_IRI, buildAidSubmodel, parseAid, protocolOf, wotTypeOf, type AidBuildInput } from '@aas/collector';
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';

const base = { assetName: 'Press1', iriBase: 'https://example.com/ids' };
const roundTrip = (input: AidBuildInput) => parseAid({ submodels: [buildAidSubmodel(input)] } as unknown as Environment)[0]!;

describe('AID building — S7 and MC (extension bindings)', () => {
  it('S7 — interface name, binding IRI and addresses survive the round trip', () => {
    const submodel = buildAidSubmodel({
      ...base,
      endpoint: 's7://192.168.0.10?rack=0&slot=1',
      tags: [
        { name: 'Speed', href: 'DB10.DBD4:REAL', type: 'float', unit: 'rpm' },
        { name: 'Running', href: 'M10.3', type: 'boolean' },
      ],
      intervalMs: 500,
    });
    const iface = (submodel['submodelElements'] as { idShort: string; supplementalSemanticIds: { keys: { value: string }[] }[] }[])[0]!;
    expect(iface.idShort).toBe('InterfaceTemplateForS7');
    expect(iface.supplementalSemanticIds.map((ref) => ref.keys[0]!.value)).toContain(BINDING_IRI.S7);
    const parsed = parseAid({ submodels: [submodel] } as unknown as Environment)[0]!;
    expect(parsed.protocol).toBe('S7');
    expect(parsed.properties.map((p) => p.href)).toEqual(['DB10.DBD4:REAL', 'M10.3']);
    expect(parsed.properties[0]!.formFields['vxp_pollingTime']).toBe('500');
  });

  it('MC — the series decides the numbering the builder checks', () => {
    const parsed = roundTrip({ ...base, endpoint: 'melsec://192.168.0.11:5000?series=iQ-F', tags: [{ name: 'Input', href: 'X17', type: 'boolean' }] });
    expect(parsed.protocol).toBe('MC');
    expect(parsed.name).toBe('InterfaceTemplateForMC');
    expect(() => buildAidSubmodel({ ...base, endpoint: 'melsec://192.168.0.11:5000?series=iQ-F', tags: [{ name: 'Input', href: 'X18' }] })).toThrow(AidBuildError);
  });

  it('refuses what the reader would refuse — before building, as AidBuildError (400), never a 500', () => {
    const bad: AidBuildInput[] = [
      { ...base, endpoint: 's7://192.168.0.10', tags: [{ name: 'A', href: 'DB1.DBW0:REAL' }] },
      { ...base, endpoint: 's7://192.168.0.10?slot=99', tags: [{ name: 'A', href: 'MW0' }] },
      { ...base, endpoint: 'melsec://192.168.0.11', tags: [{ name: 'A', href: 'D100' }] },
      { ...base, endpoint: 'melsec://192.168.0.11:5000', tags: [{ name: 'A', href: 'M10:INT' }] },
      { ...base, endpoint: 's7://192.168.0.10', tags: [{ name: 'A', href: 'MW0' }], security: { login: true } },
    ];
    for (const input of bad) expect(() => buildAidSubmodel(input), input.endpoint).toThrow(AidBuildError);
    expect(() => buildAidSubmodel(bad[0]!)).toThrow(/태그 A/);
  });

  it('protocol by binding IRI or scheme; WoT type suggestions for PLC types', () => {
    expect(protocolOf('Interface00', undefined, [BINDING_IRI.MC])).toBe('MC');
    expect(protocolOf('Interface00', 's7://h')).toBe('S7');
    expect(protocolOf('Interface00', 'melsec://h:5000')).toBe('MC');
    expect([wotTypeOf('BOOL'), wotTypeOf('REAL'), wotTypeOf('DINT'), wotTypeOf('STRING')]).toEqual(['boolean', 'float', 'integer', 'string']);
  });
});
