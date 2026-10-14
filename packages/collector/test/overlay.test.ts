/**
 * Read-only overlay of collected values.
 *
 * Important: this test has two key points.
 *  (1) Responses show live field values (same appearance as BaSyx DataBridge)
 *  (2) **The original stays unchanged** — if option A (the file is the source of truth) breaks, the product's premise collapses
 */
import { overlayEnvironment, overlaySubmodel, latestByProperty, type ValueSample } from '@aas/collector';
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';

function sample(name: string, value: number | string, at: string): ValueSample {
  return {
    packageId: 'pkg_1',
    interfaceName: 'OPCUA',
    propertyName: name,
    observedAt: at,
    ...(typeof value === 'number' ? { valueNumber: value } : { valueText: value }),
    quality: 'Good',
  };
}

const submodel = {
  modelType: 'Submodel',
  id: 'https://example.com/sm/1',
  idShort: 'OperationalData',
  submodelElements: [
    {
      modelType: 'SubmodelElementCollection',
      idShort: 'ProcessMonitoring',
      value: [
        { modelType: 'Property', idShort: 'MachineState', valueType: 'xs:string', value: 'IDLE' },
        { modelType: 'Property', idShort: 'LineSpeed', valueType: 'xs:double', value: '0' },
      ],
    },
    { modelType: 'Property', idShort: 'AlarmActive', valueType: 'xs:boolean', value: 'false' },
  ],
} as never;

describe('Overlay', () => {
  it('uses only the latest value — even when the same name arrives several times', () => {
    const latest = latestByProperty([
      sample('LineSpeed', 10, '2026-08-25T00:00:00Z'),
      sample('LineSpeed', 18.5, '2026-08-25T00:00:05Z'),
      sample('LineSpeed', 12, '2026-08-25T00:00:02Z'),
    ]);
    expect(latest.get('LineSpeed')?.valueNumber).toBe(18.5);
  });

  it('overlays values onto elements with a matching name (including deeply nested ones)', () => {
    const result = overlaySubmodel(submodel, [
      sample('MachineState', 'RUNNING', '2026-08-25T00:00:00Z'),
      sample('LineSpeed', 18.5, '2026-08-25T00:00:00Z'),
    ]);
    const collection = result.content.submodelElements![0] as never as { value: { value: string }[] };
    expect(collection.value[0]!.value).toBe('RUNNING');
    expect(collection.value[1]!.value).toBe('18.5');
    expect(result.applied).toBe(2);
  });

  it('does not touch the original — option A (the file is the source of truth)', () => {
    const before = JSON.stringify(submodel);
    overlaySubmodel(submodel, [sample('MachineState', 'RUNNING', '2026-08-25T00:00:00Z')]);
    expect(JSON.stringify(submodel)).toBe(before);
  });

  it('reports unmatched values instead of silently dropping them', () => {
    const result = overlaySubmodel(submodel, [sample('MotorSpeed', 1200, '2026-08-25T00:00:00Z')]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]).toMatchObject({ propertyName: 'MotorSpeed', outcome: 'unmatched' });
  });

  it('does not overlay on duplicate names — live values landing on the wrong element is the worst case', () => {
    const twins = {
      modelType: 'Submodel',
      id: 'x',
      idShort: 'S',
      submodelElements: [
        { modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '1' },
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'Group',
          value: [{ modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '2' }],
        },
      ],
    } as never;
    const result = overlaySubmodel(twins, [sample('Temp', 65, '2026-08-25T00:00:00Z')]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('ambiguous');
    expect(result.notes[0]!.paths).toEqual(['Temp', 'Group.Temp']);
  });

  it('does not overlay onto container elements', () => {
    const result = overlaySubmodel(submodel, [
      sample('ProcessMonitoring', 'x', '2026-08-25T00:00:00Z'),
    ]);
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('unmatched');
  });

  it('can overlay onto an entire environment', () => {
    const environment = { submodels: [submodel] } as never;
    const result = overlayEnvironment(environment, [
      sample('AlarmActive', 'true', '2026-08-25T00:00:00Z'),
    ]);
    expect(result.applied).toBe(1);
    const applied = result.content.submodels![0]!.submodelElements![1] as never as { value: string };
    expect(applied.value).toBe('true');
  });

  it('also reports when each value was read', () => {
    const result = overlaySubmodel(submodel, [
      sample('AlarmActive', 'true', '2026-08-25T01:02:03Z'),
    ]);
    expect(result.notes[0]).toMatchObject({
      outcome: 'applied',
      observedAt: '2026-08-25T01:02:03Z',
      quality: 'Good',
    });
  });
});

describe('Duplicate names across submodel boundaries', () => {
  it('overlays onto **neither** when the same name exists in another submodel', () => {
    // A realistic case: the nameplate ManufacturerName and a same-named item newly created for collection
    const environment = {
      submodels: [
        {
          modelType: 'Submodel',
          id: 'sm-dn',
          idShort: 'DigitalNameplate',
          submodelElements: [
            { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: '알에프엠기계(주)' },
          ],
        },
        {
          modelType: 'Submodel',
          id: 'sm-od',
          idShort: 'OperationalData',
          submodelElements: [
            { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: 'N/A' },
          ],
        },
      ],
    } as unknown as Environment;

    const result = overlayEnvironment(environment, [
      {
        packageId: 'p',
        interfaceName: 'I',
        propertyName: 'ManufacturerName',
        observedAt: '2026-09-01T00:00:00.000Z',
        valueText: '엉뚱한값',
      },
    ] as never);

    // Important: the nameplate value must not be overwritten by a collected value — this is the case pinned down as "worst"
    expect(result.applied).toBe(0);
    expect(result.notes[0]!.outcome).toBe('ambiguous');
    expect(result.notes[0]!.paths).toHaveLength(2);
    const shown = JSON.stringify(result.content);
    expect(shown).toContain('알에프엠기계(주)');
    expect(shown).not.toContain('엉뚱한값');
  });

  it('says which submodels the duplicates are in — otherwise they cannot be located', () => {
    const environment = {
      submodels: [
        { modelType: 'Submodel', id: 'a', idShort: 'DigitalNameplate',
          submodelElements: [{ modelType: 'Property', idShort: 'X', valueType: 'xs:string', value: '1' }] },
        { modelType: 'Submodel', id: 'b', idShort: 'OperationalData',
          submodelElements: [{ modelType: 'Property', idShort: 'X', valueType: 'xs:string', value: '2' }] },
      ],
    } as unknown as Environment;
    const result = overlayEnvironment(environment, [
      { packageId: 'p', interfaceName: 'I', propertyName: 'X',
        observedAt: '2026-09-01T00:00:00.000Z', valueText: 'v' },
    ] as never);
    expect(result.notes[0]!.paths).toEqual(['DigitalNameplate.X', 'OperationalData.X']);
  });
});
