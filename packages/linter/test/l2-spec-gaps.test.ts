/**
 * AAS 참조모델 제약조건 spec(aas-test-engines v1.0.3 기준) 전수 대조에서 메운 구멍들.
 *
 * 🔴 이 제약들은 우리 도구가 **만들지는 않지만**, 편집(semanticId 비우기)이나
 *    남의 파일 열기(XML 지원 이후)로 실제로 마주칠 수 있다. 우리 린터가 놓치면
 *    aas-test-engines에서 떨어진다 — AASd-120 사고와 같은 유형이다.
 */
import { lint, L2_RULES } from '@aas/linter';
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';

const submodel = (elements: unknown[]): Environment =>
  ({
    submodels: [
      {
        modelType: 'Submodel',
        id: 'https://example.com/sm/1',
        idShort: 'S',
        submodelElements: elements,
      },
    ],
  }) as unknown as Environment;

const hit = (env: Environment, ruleId: string) =>
  lint(env, L2_RULES).findings.filter((finding) => finding.ruleId === ruleId);

describe('AASd-118 — 보조 semanticId만 있는 요소', () => {
  it('semanticId 없이 supplementalSemanticIds만 있으면 위반', () => {
    const env = submodel([
      {
        modelType: 'Property',
        idShort: 'P',
        valueType: 'xs:string',
        value: 'x',
        supplementalSemanticIds: [
          { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'https://idta.io/x' }] },
        ],
      },
    ]);
    expect(hit(env, 'AASd-118')).toHaveLength(1);
  });

  it('둘 다 있으면 통과 — 골든 파일이 실제로 이 모양이다', () => {
    const env = submodel([
      {
        modelType: 'Property',
        idShort: 'P',
        valueType: 'xs:string',
        value: 'x',
        semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'https://a' }] },
        supplementalSemanticIds: [
          { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'https://b' }] },
        ],
      },
    ]);
    expect(hit(env, 'AASd-118')).toHaveLength(0);
  });
});

describe('AASd-123/125/127 — 모델 참조 키 사슬', () => {
  const withSemantic = (semanticId: unknown): Environment =>
    submodel([{ modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: 'x', semanticId }]);

  it('ModelReference 첫 키가 Property면 위반 (AASd-123)', () => {
    const env = withSemantic({ type: 'ModelReference', keys: [{ type: 'Property', value: 'x' }] });
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('AAS 식별 대상이'))).toBe(true);
  });

  it('둘째 키가 Submodel이면 위반 (AASd-125)', () => {
    const env = withSemantic({
      type: 'ModelReference',
      keys: [
        { type: 'Submodel', value: 'https://example.com/sm/1' },
        { type: 'Submodel', value: 'https://example.com/sm/2' },
      ],
    });
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('요소류가 아닙니다'))).toBe(true);
  });

  it('File 뒤의 FragmentReference는 통과, Property 뒤면 위반 (AASd-126·127)', () => {
    const good = withSemantic({
      type: 'ModelReference',
      keys: [
        { type: 'Submodel', value: 'https://example.com/sm/1' },
        { type: 'File', value: 'Doc' },
        { type: 'FragmentReference', value: '#page=3' },
      ],
    });
    expect(hit(good, 'AASd-121~128')).toHaveLength(0);

    const bad = withSemantic({
      type: 'ModelReference',
      keys: [
        { type: 'Submodel', value: 'https://example.com/sm/1' },
        { type: 'Property', value: 'P' },
        { type: 'FragmentReference', value: '#x' },
      ],
    });
    expect(hit(bad, 'AASd-121~128').some((f) => f.message.includes('File·Blob이 아닙니다'))).toBe(true);
  });

  it('정상 사슬(Submodel→SMC→Property)은 통과', () => {
    const env = withSemantic({
      type: 'ModelReference',
      keys: [
        { type: 'Submodel', value: 'https://example.com/sm/1' },
        { type: 'SubmodelElementCollection', value: 'G' },
        { type: 'Property', value: 'P' },
      ],
    });
    expect(hit(env, 'AASd-121~128')).toHaveLength(0);
  });
});

describe('AASd-116/133 — SpecificAssetId', () => {
  const withAsset = (specificAssetIds: unknown[]): Environment =>
    ({
      assetAdministrationShells: [
        {
          modelType: 'AssetAdministrationShell',
          id: 'https://example.com/aas/1',
          idShort: 'A',
          assetInformation: { assetKind: 'Type', specificAssetIds },
        },
      ],
    }) as unknown as Environment;

  it('예약 이름 globalAssetId는 위반 (대소문자 무시)', () => {
    const env = withAsset([{ name: 'GlobalAssetId', value: 'urn:x' }]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(1);
  });

  it('externalSubjectId가 ModelReference면 위반', () => {
    const env = withAsset([
      { name: 'serial', value: '123', externalSubjectId: { type: 'ModelReference', keys: [] } },
    ]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(1);
  });

  it('정상이면 통과', () => {
    const env = withAsset([
      { name: 'serial', value: '123', externalSubjectId: { type: 'ExternalReference', keys: [] } },
    ]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(0);
  });
});

describe('AASc-3a-010 — value와 valueList 배타', () => {
  const cd = (content: Record<string, unknown>): Environment =>
    ({
      conceptDescriptions: [
        {
          modelType: 'ConceptDescription',
          id: 'https://example.com/cd/1',
          idShort: 'C',
          embeddedDataSpecifications: [
            {
              dataSpecification: {
                type: 'ExternalReference',
                keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0' }],
              },
              dataSpecificationContent: { modelType: 'DataSpecificationIec61360', preferredName: [{ language: 'en', text: 'C' }], ...content },
            },
          ],
        },
      ],
    }) as unknown as Environment;

  it('둘 다 있으면 위반', () => {
    const env = cd({
      value: '42',
      valueList: { valueReferencePairs: [{ value: '42', valueId: { type: 'ExternalReference', keys: [] } }] },
    });
    expect(hit(env, 'AASc-3a-010')).toHaveLength(1);
  });

  it('하나만 있으면 통과', () => {
    expect(hit(cd({ value: '42' }), 'AASc-3a-010')).toHaveLength(0);
    expect(
      hit(cd({ valueList: { valueReferencePairs: [{ value: '42' }] } }), 'AASc-3a-010'),
    ).toHaveLength(0);
  });
});

describe('AASd-119/129 — TemplateQualifier 일관성', () => {
  const withQualifier = (kind: string | undefined): Environment =>
    ({
      submodels: [
        {
          modelType: 'Submodel',
          id: 'https://example.com/sm/1',
          idShort: 'S',
          ...(kind === undefined ? {} : { kind }),
          submodelElements: [
            {
              modelType: 'Property',
              idShort: 'P',
              valueType: 'xs:string',
              value: 'x',
              qualifiers: [{ kind: 'TemplateQualifier', type: 'Cardinality', valueType: 'xs:string' }],
            },
          ],
        },
      ],
    }) as unknown as Environment;

  it('Instance 서브모델 안의 TemplateQualifier는 위반', () => {
    expect(hit(withQualifier('Instance'), 'AASd-119/129')).toHaveLength(1);
    expect(hit(withQualifier(undefined), 'AASd-119/129')).toHaveLength(1);
  });

  it('Template 서브모델 안이면 통과', () => {
    expect(hit(withQualifier('Template'), 'AASd-119/129')).toHaveLength(0);
  });

  it('일반 Qualifier(ConceptQualifier)는 상관없다', () => {
    const env = withQualifier('Instance');
    (env.submodels![0]!.submodelElements![0] as never as { qualifiers: { kind: string }[] }).qualifiers[0]!.kind =
      'ConceptQualifier';
    expect(hit(env, 'AASd-119/129')).toHaveLength(0);
  });
});

describe('AASd-128 — 리스트 키 뒤는 정수 색인', () => {
  const withRef = (keys: { type: string; value: string }[]): Environment =>
    submodel([
      {
        modelType: 'Property',
        idShort: 'P',
        valueType: 'xs:string',
        value: 'x',
        semanticId: { type: 'ModelReference', keys },
      },
    ]);

  it('SubmodelElementList 키 뒤가 이름이면 위반', () => {
    const env = withRef([
      { type: 'Submodel', value: 'https://example.com/sm/1' },
      { type: 'SubmodelElementList', value: 'Markings' },
      { type: 'SubmodelElementCollection', value: 'MarkingsEntry_0' },
    ]);
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('정수 색인이'))).toBe(true);
  });

  it('정수면 통과', () => {
    const env = withRef([
      { type: 'Submodel', value: 'https://example.com/sm/1' },
      { type: 'SubmodelElementList', value: 'Markings' },
      { type: 'SubmodelElementCollection', value: '0' },
    ]);
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('정수 색인이'))).toBe(false);
  });
});

describe('AASd-130 — XML 금지 문자', () => {
  it('제어문자가 든 값은 위반 (복사·붙여넣기로 흔히 들어온다)', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: '온도\u0000값' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(1);
  });

  it('홀 서로게이트도 위반 — JSON은 통과시키지만 XML 도구가 죽는다', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: 'x\uD800y' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(1);
  });

  it('한글·개행·탭·이모지는 통과', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: '줄1\n줄2\t끝 🏭 한글' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(0);
  });
});

describe('AASd-134 — Operation 변수 이름', () => {
  const operation = (names: string[][]): Environment =>
    submodel([
      {
        modelType: 'Operation',
        idShort: 'Op',
        inputVariables: names[0]!.map((n) => ({ value: { modelType: 'Property', idShort: n } })),
        outputVariables: names[1]!.map((n) => ({ value: { modelType: 'Property', idShort: n } })),
      },
    ]);

  it('입력과 출력에 같은 이름이 있으면 위반', () => {
    expect(hit(operation([['a'], ['a']]), 'AASd-134')).toHaveLength(1);
  });

  it('전부 다르면 통과', () => {
    expect(hit(operation([['a', 'b'], ['c']]), 'AASd-134')).toHaveLength(0);
  });
});
