/**
 * Gaps closed by a full comparison against the AAS reference-model constraint spec
 * (as of aas-test-engines v1.0.3).
 *
 * Important: our tool **never produces** these, but they can really show up through editing
 *    (clearing a semanticId) or opening someone else's file (since XML support). If our linter
 *    misses them, the file fails in aas-test-engines — the same kind of incident as AASd-120.
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

describe('AASd-118 — elements with only supplemental semanticIds', () => {
  it('supplementalSemanticIds without a semanticId is a violation', () => {
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

  it('passes when both are present — the golden file actually has this shape', () => {
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

describe('AASd-123/125/127 — model reference key chain', () => {
  const withSemantic = (semanticId: unknown): Environment =>
    submodel([{ modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: 'x', semanticId }]);

  it('a ModelReference whose first key is Property is a violation (AASd-123)', () => {
    const env = withSemantic({ type: 'ModelReference', keys: [{ type: 'Property', value: 'x' }] });
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('AAS 식별 대상이'))).toBe(true);
  });

  it('a second key of Submodel is a violation (AASd-125)', () => {
    const env = withSemantic({
      type: 'ModelReference',
      keys: [
        { type: 'Submodel', value: 'https://example.com/sm/1' },
        { type: 'Submodel', value: 'https://example.com/sm/2' },
      ],
    });
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('요소류가 아닙니다'))).toBe(true);
  });

  it('FragmentReference after File passes, after Property is a violation (AASd-126/127)', () => {
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

  it('a valid chain (Submodel→SMC→Property) passes', () => {
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

  it('the reserved name globalAssetId is a violation (case-insensitive)', () => {
    const env = withAsset([{ name: 'GlobalAssetId', value: 'urn:x' }]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(1);
  });

  it('an externalSubjectId that is a ModelReference is a violation', () => {
    const env = withAsset([
      { name: 'serial', value: '123', externalSubjectId: { type: 'ModelReference', keys: [] } },
    ]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(1);
  });

  it('passes when valid', () => {
    const env = withAsset([
      { name: 'serial', value: '123', externalSubjectId: { type: 'ExternalReference', keys: [] } },
    ]);
    expect(hit(env, 'AASd-116/133')).toHaveLength(0);
  });
});

describe('AASc-3a-010 — value and valueList are mutually exclusive', () => {
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

  it('both present is a violation', () => {
    const env = cd({
      value: '42',
      valueList: { valueReferencePairs: [{ value: '42', valueId: { type: 'ExternalReference', keys: [] } }] },
    });
    expect(hit(env, 'AASc-3a-010')).toHaveLength(1);
  });

  it('only one present passes', () => {
    expect(hit(cd({ value: '42' }), 'AASc-3a-010')).toHaveLength(0);
    expect(
      hit(cd({ valueList: { valueReferencePairs: [{ value: '42' }] } }), 'AASc-3a-010'),
    ).toHaveLength(0);
  });
});

describe('AASd-119/129 — TemplateQualifier consistency', () => {
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

  it('a TemplateQualifier inside an Instance submodel is a violation', () => {
    expect(hit(withQualifier('Instance'), 'AASd-119/129')).toHaveLength(1);
    expect(hit(withQualifier(undefined), 'AASd-119/129')).toHaveLength(1);
  });

  it('passes inside a Template submodel', () => {
    expect(hit(withQualifier('Template'), 'AASd-119/129')).toHaveLength(0);
  });

  it('an ordinary Qualifier (ConceptQualifier) is unaffected', () => {
    const env = withQualifier('Instance');
    (env.submodels![0]!.submodelElements![0] as never as { qualifiers: { kind: string }[] }).qualifiers[0]!.kind =
      'ConceptQualifier';
    expect(hit(env, 'AASd-119/129')).toHaveLength(0);
  });
});

describe('AASd-128 — the key after a list key must be an integer index', () => {
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

  it('a name after a SubmodelElementList key is a violation', () => {
    const env = withRef([
      { type: 'Submodel', value: 'https://example.com/sm/1' },
      { type: 'SubmodelElementList', value: 'Markings' },
      { type: 'SubmodelElementCollection', value: 'MarkingsEntry_0' },
    ]);
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('정수 색인이'))).toBe(true);
  });

  it('an integer passes', () => {
    const env = withRef([
      { type: 'Submodel', value: 'https://example.com/sm/1' },
      { type: 'SubmodelElementList', value: 'Markings' },
      { type: 'SubmodelElementCollection', value: '0' },
    ]);
    expect(hit(env, 'AASd-121~128').some((f) => f.message.includes('정수 색인이'))).toBe(false);
  });
});

describe('AASd-130 — characters forbidden in XML', () => {
  it('a value containing control characters is a violation (commonly introduced by copy-paste)', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: '온도\u0000값' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(1);
  });

  it('a lone surrogate is also a violation — JSON lets it through but XML tools crash', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: 'x\uD800y' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(1);
  });

  it('Hangul, newlines, tabs and emoji pass', () => {
    const env = submodel([
      { modelType: 'Property', idShort: 'P', valueType: 'xs:string', value: '줄1\n줄2\t끝 🏭 한글' },
    ]);
    expect(hit(env, 'AASd-130')).toHaveLength(0);
  });
});

describe('AASd-134 — Operation variable names', () => {
  const operation = (names: string[][]): Environment =>
    submodel([
      {
        modelType: 'Operation',
        idShort: 'Op',
        inputVariables: names[0]!.map((n) => ({ value: { modelType: 'Property', idShort: n } })),
        outputVariables: names[1]!.map((n) => ({ value: { modelType: 'Property', idShort: n } })),
      },
    ]);

  it('the same name in inputs and outputs is a violation', () => {
    expect(hit(operation([['a'], ['a']]), 'AASd-134')).toHaveLength(1);
  });

  it('all distinct passes', () => {
    expect(hit(operation([['a', 'b'], ['c']]), 'AASd-134')).toHaveLength(0);
  });
});
