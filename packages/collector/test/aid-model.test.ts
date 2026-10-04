/**
 * 수집 항목 자리 만들기 검증 — 「AID는 만들었는데 값이 안 나간다」를 없애는 기능.
 *
 * 보는 것 셋:
 *  ① KTL 계층(OperationalData > 대분류 > 소분류 > Prop)을 지키는가 — 골든 파일과 같은 모양인가
 *  ② 🔴 **이미 있는 것을 건드리지 않는가** — 사람이 한 일과 쌓인 값을 지우면 안 된다
 *  ③ semanticId 키 타입이 맞는가 — 틀리면 basyx가 서브모델을 통째로 드롭한다
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
  it('AID 타입을 xs 자료형으로 옮긴다', () => {
    expect(runtimeValueType('integer')).toBe('xs:int');
    expect(runtimeValueType('boolean')).toBe('xs:boolean');
    expect(runtimeValueType('string')).toBe('xs:string');
    expect(runtimeValueType('float')).toBe('xs:double');
  });

  it('🔴 모르면 xs:double — 수집되는 것 대부분이 측정값이다', () => {
    expect(runtimeValueType(undefined)).toBe('xs:double');
  });
});

describe('mergeRuntimeGroup', () => {
  it('🔴 KTL 계층 그대로 만든다 — 대분류 > 소분류 > Property', () => {
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

  it('🔴 semanticId는 ModelReference + ConceptDescription 키 — 골든 파일 실측 형태', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x' }]));
    const group = (result.submodel['submodelElements'] as Record<string, unknown>[])[0];
    const sub = (group?.['value'] as Record<string, unknown>[])[0];
    const prop = (sub?.['value'] as Record<string, unknown>[])[0];
    expect(prop?.['semanticId']).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'ConceptDescription', value: `${IRI}/cd/MotorSpeed/1/0` }],
    });
  });

  it('🔴 자료형에 맞는 예시 값이 들어간다 — 빈 값은 KOSMO-SME-4 위반이다', () => {
    const leaf = (input: Parameters<typeof mergeRuntimeGroup>[1]): Record<string, unknown> => {
      const result = mergeRuntimeGroup(emptySubmodel(), input);
      const group = (result.submodel['submodelElements'] as Record<string, unknown>[])[0];
      return ((group?.['value'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0]!;
    };
    // Template의 **예시 칸**이지 측정값이 아니다 — 수집이 붙으면 live/OPC UA에서 덮인다
    expect(leaf(base([{ name: 'A', href: 'x', type: 'float' }]))['value']).toBe('0.0');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'integer' }]))['value']).toBe('0');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'boolean' }]))['value']).toBe('false');
    expect(leaf(base([{ name: 'A', href: 'x', type: 'string' }]))['value']).toBe('N/A');
  });

  /** CD 안의 dataSpecificationContent를 꺼낸다 */
  const specOf = (result: ReturnType<typeof mergeRuntimeGroup>, name: string): Record<string, unknown> => {
    const cd = result.conceptDescriptions.find((item) => item['idShort'] === name)!;
    const spec = (cd['embeddedDataSpecifications'] as Record<string, unknown>[])[0];
    return spec?.['dataSpecificationContent'] as Record<string, unknown>;
  };

  it('🔴 CD의 dataType이 valueType과 맞는다 — 안 맞으면 KOSMO-SME-5 (실측으로 걸렸다)', () => {
    const result = mergeRuntimeGroup(
      emptySubmodel(),
      base([{ name: 'MotorSpeed', href: 'x', type: 'float', unit: 'rpm' }]),
    );
    expect(specOf(result, 'MotorSpeed')['dataType']).toBe('REAL_MEASURE');
    expect(specOf(result, 'MotorSpeed')['unit']).toBe('rpm');
  });

  it('🔴 단위를 모르면 MEASURE가 아니라 COUNT로 낸다 — AASc-3a-009 (실측으로 걸렸다)', () => {
    // 「12.5」가 kW인지 A인지 모르는데 MEASURE라고 적으면 만든 순간 위반이 뜬다.
    // 단위를 지어내는 것은 더 나쁘다 — 틀린 단위는 안 붙은 것보다 위험하다.
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x', type: 'float' }]));
    expect(specOf(result, 'MotorSpeed')['dataType']).toBe('REAL_COUNT');
    expect(specOf(result, 'MotorSpeed')).not.toHaveProperty('unit');
  });

  it('🔴 이미 있는 이름은 건드리지 않는다 — 쌓인 값과 사람이 한 일을 지우지 않는다', () => {
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
    // 원래 자리의 값이 그대로다
    const old = (((result.submodel['submodelElements'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0]?.['value'] as Record<string, unknown>[])[0];
    expect(old?.['value']).toBe('1200');
  });

  it('대분류·소분류가 이미 있으면 그 안에 합친다 — 두 번 만들지 않는다', () => {
    const first = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'A', href: 'x' }]));
    const second = mergeRuntimeGroup(first.submodel, base([{ name: 'B', href: 'y' }]));
    const roots = second.submodel['submodelElements'] as Record<string, unknown>[];
    expect(roots).toHaveLength(1);
    const sub = (roots[0]?.['value'] as Record<string, unknown>[]);
    expect(sub).toHaveLength(1);
    expect((sub[0]?.['value'] as Record<string, unknown>[]).map((n) => n['idShort'])).toEqual(['A', 'B']);
  });

  it('CD를 함께 낸다 — 대분류·소분류·항목 전부 (KOSMO-SME-3)', () => {
    const result = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'MotorSpeed', href: 'x', unit: 'rpm' }]));
    expect(result.conceptDescriptions.map((cd) => cd['idShort'])).toEqual([
      'ProcessMonitoring',
      'CollectedValues',
      'MotorSpeed',
    ]);
    // 표준 사전에 대응이 없으므로 가리킬 원본이 없다
    expect(result.conceptDescriptions[0]).not.toHaveProperty('isCaseOf');
  });

  it('전부 이미 있으면 아무것도 만들지 않는다', () => {
    const first = mergeRuntimeGroup(emptySubmodel(), base([{ name: 'A', href: 'x' }]));
    const second = mergeRuntimeGroup(first.submodel, base([{ name: 'A', href: 'x' }]));
    expect(second.added).toEqual([]);
    expect(second.conceptDescriptions).toEqual([]);
  });

  it('🔴 빈 SMC를 남기지 않는다 — V3.0 스키마가 빈 배열을 거부한다', () => {
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

  it('요소 이름으로 못 쓰는 것은 미리 막는다', () => {
    expect(() => mergeRuntimeGroup(emptySubmodel(), { ...base([{ name: '한글이름', href: 'x' }]) })).toThrow(
      RuntimeBuildError,
    );
    expect(() =>
      mergeRuntimeGroup(emptySubmodel(), { ...base([{ name: 'A', href: 'x' }]), group: '1번' }),
    ).toThrow(RuntimeBuildError);
  });

  it('입력 서브모델을 고치지 않는다 — 사본을 돌려준다', () => {
    const original = emptySubmodel();
    mergeRuntimeGroup(original, base([{ name: 'A', href: 'x' }]));
    expect(original).not.toHaveProperty('submodelElements');
  });
});
