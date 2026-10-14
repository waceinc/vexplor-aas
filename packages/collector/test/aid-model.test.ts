/**
 * Tests for creating collection-item slots — the feature that eliminates "the AID exists but no values come out".
 *
 * Three things checked:
 *  (1) Does it keep the KTL hierarchy (OperationalData > category > subcategory > Prop) — same shape as the golden file?
 *  (2) Important: **does it leave existing content untouched** — human work and accumulated values must not be erased
 *  (3) Is the semanticId key type correct — if wrong, basyx drops the whole submodel
 */
import { describe, expect, it } from 'vitest';
import {
  mergeRuntimeGroup,
  runtimeValueType,
  RuntimeBuildError,
  type RuntimeGroupInput,
} from '../src/aid-model.js';

const IRI = 'https://www.smart-factory.kr/ids';

const base = (tags: RuntimeGroupInput['tags']): RuntimeGroupInput => ({
  iriBase: IRI,
  group: 'ProcessMonitoring',
  subgroup: 'CollectedValues',
  tags,
});

const emptySubmodel = (): Record<string, unknown> => ({
  modelType: 'Submodel',
  id: `${IRI}/sm/X/OperationalData/1/0`,
  idShort: 'OperationalData',
});

describe('runtimeValueType', () => {
  it('maps AID types to xs data types', () => {
    expect(runtimeValueType('integer')).toBe('xs:int');
    expect(runtimeValueType('boolean')).toBe('xs:boolean');
    expect(runtimeValueType('string')).toBe('xs:string');
    expect(runtimeValueType('float')).toBe('xs:double');
  });

  it('defaults to xs:double when unknown — most collected values are measurements', () => {
    expect(runtimeValueType(undefined)).toBe('xs:double');
  });
});

describe('mergeRuntimeGroup', () => {
  it('builds the KTL hierarchy as is — category > subcategory > Property', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'ns=1;s=a', type: 'float' }]));
    const group = (result.submodel['submodelElements'] as Record<string, unknown>[])[0];
    expect(group).toMatchObject({ modelType: 'SubmodelElementCollection', idShort: 'ProcessMonitoring' });
    const sub = (group?.['value'] as Record<string, unknown>[])[0];
    expect(sub).toMatchObject({ modelType: 'SubmodelElementCollection', idShort: 'CollectedValues' });
    expect((sub?.['value'] as Record<string, unknown>[])[0]).toMatchObject({
      modelType: 'Property',
      idShort: 'MotorSpeed',
      valueType: 'xs:double',
    });
    expect(result.added).toEqual(['MotorSpeed']);
  });

  it('semanticId is a ModelReference + ConceptDescription key — the shape measured in the golden file', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x' }]));
    const group = (result.submodel['submodelElements'] as Record<string, unknown>[])[0];
    const sub = (group?.['value'] as Record<string, unknown>[])[0];
    const prop = (sub?.['value'] as Record<string, unknown>[])[0];
    expect(prop?.['semanticId']).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'ConceptDescription', value: `${IRI}/cd/MotorSpeed/1/0` }],
    });
  });

  it('fills an example value matching the data type — an empty value violates KOSMO-SME-4', () => {
    const leaf = (input: Parameters<typeof mergeRuntimeGroup>[1]): Record<string, unknown> => {
      const result = mergeRuntimeGroup(emptySubmodel(), input);
      const group = (result.submodel['submodelElements'] as Record<string, unknown>[])[0];
      return ((group?.['value'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0]!;
    };
    // This is the Template's **example slot**, not a measurement — overwritten from live/OPC UA once collection runs
    expect(leaf(base([{ name: 'A', href: 'x', type: 'float' }]))['value']).toBe('0.0');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'integer' }]))['value']).toBe('0');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'boolean' }]))['value']).toBe('false');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'string' }]))['value']).toBe('N/A');
  });

  /** Extract dataSpecificationContent from a CD */
  const specOf = (result: ReturnType<typeof mergeRuntimeGroup>, name: string): Record<string, unknown> => {
    const cd = result.conceptDescriptions.find((item) => item['idShort'] === name)!;
    const spec = (cd['embeddedDataSpecifications'] as Record<string, unknown>[])[0];
    return spec?.['dataSpecificationContent'] as Record<string, unknown>;
  };

  it('CD dataType matches valueType — a mismatch is KOSMO-SME-5 (caught in real measurement)', () => {
    const result = mergeRuntimeGroup(
      emptySubmodel(),
      base([{ name: 'MotorSpeed', href: 'x', type: 'float', unit: 'rpm' }]),
    );
    expect(specOf(result, 'MotorSpeed')['dataType']).toBe('REAL_MEASURE');
    expect(specOf(result, 'MotorSpeed')['unit']).toBe('rpm');
  });

  it('emits COUNT instead of MEASURE when the unit is unknown — AASc-3a-009 (caught in real measurement)', () => {
    // If we don't know whether "12.5" is kW or A and still write MEASURE, a violation appears the moment it is created.
    // Inventing a unit is worse — a wrong unit is more dangerous than none.
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x', type: 'float' }]));
    expect(specOf(result, 'MotorSpeed')['dataType']).toBe('REAL_COUNT');
    expect(specOf(result, 'MotorSpeed')).not.toHaveProperty('unit');
  });

  it('leaves existing names untouched — never erases accumulated values or human work', () => {
    const existing = {
      ...emptySubmodel(),
      submodelElements: [
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'MaintenanceMonitoring',
          value: [
            {
              modelType: 'SubmodelElementCollection',
              idShort: 'ConditionStatus',
              value: [{ modelType: 'Property', idShort: 'MotorSpeed', valueType: 'xs:double', value: '1200' }],
            },
          ],
        },
      ],
    };
    const result = mergeRuntimeGroup(existing, base([
      { name: 'MotorSpeed', href: 'x' },
      { name: 'AlarmActive', href: 'y', type: 'boolean' },
    ]));
    expect(result.kept).toEqual(['MotorSpeed']);
    expect(result.added).toEqual(['AlarmActive']);
    // The value in the original slot is unchanged
    const old = (((result.submodel['submodelElements'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0];
    expect(old?.['value']).toBe('1200');
  });

  it('merges into existing category/subcategory — never creates them twice', () => {
    const first = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'A', href: 'x' }]));
    const second = mergeRuntimeGroup(first.submodel, base([{ name: 'B', href: 'y' }]));
    const roots = second.submodel['submodelElements'] as Record<string, unknown>[];
    expect(roots).toHaveLength(1);
    const sub = (roots[0]?.['value'] as Record<string, unknown>[]);
    expect(sub).toHaveLength(1);
    expect((sub[0]?.['value'] as Record<string, unknown>[]).map((n) => n['idShort'])).toEqual(['A', 'B']);
  });

  it('emits CDs too — for category, subcategory and every item (KOSMO-SME-3)', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x', unit: 'rpm' }]));
    expect(result.conceptDescriptions.map((cd) => cd['idShort'])).toEqual([
      'ProcessMonitoring',
      'CollectedValues',
      'MotorSpeed',
    ]);
    // No counterpart in the standard dictionary, so there is no source to point to
    expect(result.conceptDescriptions[0]).not.toHaveProperty('isCaseOf');
  });

  it('creates nothing when everything already exists', () => {
    const first = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'A', href: 'x' }]));
    const second = mergeRuntimeGroup(first.submodel, base([{ name: 'A', href: 'x' }]));
    expect(second.added).toEqual([]);
    expect(second.conceptDescriptions).toEqual([]);
  });

  it('leaves no empty SMC — the V3.0 schema rejects empty arrays', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'A', href: 'x' }]));
    const walk = (nodes: Record<string, unknown>[]): void => {
      for (const node of nodes) {
        if (node['modelType'] === 'SubmodelElementCollection') {
          expect((node['value'] as unknown[]).length).toBeGreaterThan(0);
          walk(node['value'] as Record<string, unknown>[]);
        }
      }
    };
    walk(result.submodel['submodelElements'] as Record<string, unknown>[]);
  });

  it('rejects invalid element names up front', () => {
    expect(() => mergeRuntimeGroup(emptySubmodel(), { ...base([{ name: '한글이름', href: 'x' }]) })).toThrow(
      RuntimeBuildError,
    );
    expect(() =>
      mergeRuntimeGroup(emptySubmodel(), { ...base([{ name: 'A', href: 'x' }]), group: '1번' }),
    ).toThrow(RuntimeBuildError);
  });

  it('does not mutate the input submodel — returns a copy', () => {
    const original = emptySubmodel();
    mergeRuntimeGroup(original, base([{ name: 'A', href: 'x' }]));
    expect(original).not.toHaveProperty('submodelElements');
  });
});
