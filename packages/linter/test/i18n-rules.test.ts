/**
 * 규칙 문구의 영어 — 지적 문구 · 고칠 방법 · 정책 메모 · 규칙 제목이 영어 요청에서 한국어를 남기지 않는가.
 *
 * 골든 파일은 지적이 적어 규칙 대부분을 지나치지 않는다. 그래서 골든 파일을 한 번 그대로,
 * 한 번 일부러 망가뜨려(규칙 대부분이 걸리게) 두 언어로 돌린다. `tr()` 하나를 빼면
 * 그 문장이 한국어로 남아 여기서 떨어진다.
 */
import { readAasx } from '@aas/aasx';
import { setLangSource, type Environment, type Lang } from '@aas/core';
import { ALL_RULES, lint, ruleCatalog, type LintResult } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const HANGUL = /[가-힣]/;

const golden = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));

/** 규칙 대부분이 걸리도록 골든 Environment를 망가뜨린다 */
function broken(): Environment {
  const env = structuredClone(golden.environment) as Environment;
  const raw = env as unknown as Record<string, unknown[]>;
  const shell = env.assetAdministrationShells![0]! as unknown as Record<string, unknown>;
  shell['idShort'] = '1 bad name';
  shell['administration'] = { revision: '0' };
  const info = shell['assetInformation'] as Record<string, unknown>;
  info['assetKind'] = 'Instance';
  delete info['globalAssetId'];
  info['specificAssetIds'] = [];
  delete info['defaultThumbnail'];

  const submodels = raw['submodels'] as Record<string, unknown>[];
  submodels[0]!['kind'] = 'Instance';
  delete submodels[0]!['semanticId'];
  submodels[1]!['idShort'] = submodels[0]!['idShort'];
  submodels[2]!['idShort'] = '-x';
  submodels[2]!['semanticId'] = {
    type: 'ExternalReference',
    keys: [{ type: 'Submodel', value: 'http://example.com/not-allowed' }],
  };
  const elements = submodels[0]!['submodelElements'] as Record<string, unknown>[];
  elements.push(
    { modelType: 'Property', idShort: '9bad', valueType: 'xs:string', value: '', category: 'WRONG' },
    { modelType: 'Property', idShort: 'Twin', valueType: 'xs:string', value: 'a\u0001b' },
    { modelType: 'Property', idShort: 'Twin', valueType: 'xs:int', value: '1' },
    { modelType: 'Operation', idShort: 'DoIt', inputVariables: [{ value: { modelType: 'Property', idShort: 'v', valueType: 'xs:int' } }], outputVariables: [{ value: { modelType: 'Property', idShort: 'v', valueType: 'xs:int' } }] },
    { modelType: 'File', idShort: 'Manual', contentType: 'application/pdf', value: 'docs/manual.pdf' },
    { modelType: 'SubmodelElementCollection', idShort: 'Empty', value: [] },
    { modelType: 'Entity', idShort: 'Self', entityType: 'SelfManagedEntity', statements: [] },
    {
      modelType: 'SubmodelElementList',
      idShort: 'Mixed',
      typeValueListElement: 'Property',
      semanticIdListElement: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: '0173-1#02-AAA000#001' }] },
      value: [
        { modelType: 'Property', idShort: 'named', valueType: 'xs:string', value: 'x', semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: '345345' }] } },
        { modelType: 'Range', valueType: 'xs:int' },
      ],
    },
  );

  const cds = raw['conceptDescriptions'] as Record<string, unknown>[];
  delete cds[0]!['idShort'];
  cds[1]!['id'] = 'http://example.com/bad-cd';
  delete cds[2]!['embeddedDataSpecifications'];
  cds.push(structuredClone(cds[3]!), { id: 'urn:x', idShort: 'x', administration: { revision: '1' } });
  // IEC 61360 내용 — 영문 이름 없음 · 단위 없는 MEASURE · value와 valueList 동시 · 언어 태그 중복
  const content = (cds[4]!['embeddedDataSpecifications'] as { dataSpecificationContent: Record<string, unknown> }[])[0]!
    .dataSpecificationContent;
  content['preferredName'] = [{ language: 'de', text: 'Name' }];
  content['definition'] = [{ language: 'en', text: 'a' }, { language: 'en', text: 'b' }];
  content['dataType'] = 'REAL_MEASURE';
  delete content['unit'];
  delete content['unitId'];
  content['value'] = '1';
  content['valueList'] = { valueReferencePairs: [{ value: 'a', valueId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:a' }] } }] };

  // 보조 semanticId만 · TemplateQualifier(서브모델 kind는 Instance)
  elements.push(
    { modelType: 'Property', idShort: 'Extra', valueType: 'xs:string', value: 'x', supplementalSemanticIds: [{ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:s' }] }] },
    { modelType: 'Property', idShort: 'Templated', valueType: 'xs:string', value: 'x', qualifiers: [{ kind: 'TemplateQualifier', type: 'Cardinality', valueType: 'xs:string', value: 'One' }] },
  );

  // 값 검사 대상 서브모델(명판 · 문서 제외)에 빈 값 · CD와 안 맞는 valueType
  const checked = submodels.find((sm) => !['DigitalNameplate', 'HandoverDocumentation'].includes(String(sm['idShort'])))!;
  delete (checked['administration'] as Record<string, unknown> | undefined)?.['revision'];
  const stringCd = cds[5]!;
  (stringCd['embeddedDataSpecifications'] as { dataSpecificationContent: Record<string, unknown> }[])[0]!
    .dataSpecificationContent['dataType'] = 'STRING';
  (checked['submodelElements'] as Record<string, unknown>[]).push(
    { modelType: 'Property', idShort: 'Blank', valueType: 'xs:string', value: '' },
    {
      modelType: 'Property',
      idShort: 'Flag',
      valueType: 'xs:boolean',
      value: 'true',
      semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: String(stringCd['id']) }] },
    },
  );

  // 예약 이름 specificAssetId를 가진 둘째 AAS
  const second = structuredClone(env.assetAdministrationShells![0]!) as unknown as Record<string, unknown>;
  second['id'] = 'urn:second';
  (second['assetInformation'] as Record<string, unknown>)['specificAssetIds'] = [
    { name: 'globalAssetId', value: 'x', externalSubjectId: { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:x' }] } },
  ];
  raw['assetAdministrationShells']!.push(second);

  // 계층 — 진입점 없는 것 하나, 자기 참조 · 중복 · 주소 없음 · 끊긴 관계 · 틀린 ArcheType이 있는 것 하나
  const asset = (id: string) => ({ modelType: 'Entity', idShort: id, entityType: 'SelfManagedEntity', globalAssetId: `urn:asset:${id}` });
  const relation = (target: string) => ({
    modelType: 'RelationshipElement',
    idShort: `HasPart_${target}`,
    first: { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:h' }, { type: 'Entity', value: 'Line' }] },
    second: { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:h' }, { type: 'Entity', value: target }] },
  });
  raw['submodels']!.push(
    { modelType: 'Submodel', id: 'urn:h0', idShort: 'HierarchicalStructures', kind: 'Template', submodelElements: [{ modelType: 'Property', idShort: 'ArcheType', valueType: 'xs:string', value: 'Full' }] },
    {
      modelType: 'Submodel',
      id: 'urn:h',
      idShort: 'HierarchicalStructures',
      kind: 'Template',
      submodelElements: [
        {
          ...asset('Line'),
          statements: [
            asset('Line'),
            asset('RobotA'),
            { ...asset('RobotB'), globalAssetId: 'urn:asset:RobotA' },
            { modelType: 'Entity', idShort: 'NoAddress', entityType: 'SelfManagedEntity' },
            relation('RobotA'),
            relation('Gone'),
          ],
        },
        { modelType: 'Property', idShort: 'ArcheType', valueType: 'xs:string', value: 'Sideways' },
      ],
    },
  );
  return env;
}

function run(lang: Lang): { golden: LintResult; broken: LintResult } {
  setLangSource(() => lang);
  return {
    golden: lint(golden.environment, ALL_RULES, { package: golden.opc }),
    broken: lint(broken(), ALL_RULES, { package: golden.opc }),
  };
}

function texts(result: LintResult): string[] {
  return result.findings.flatMap((f) => [f.message, f.remedy ?? '', f.policyNote ?? '']);
}

afterEach(() => setLangSource(() => 'ko'));

describe('규칙 문구 영어', () => {
  it('영어 요청이면 지적 문구 · 고칠 방법 · 정책 메모에 한국어가 없다', () => {
    const en = run('en');
    expect(en.golden.findings.length).toBeGreaterThan(0);
    const leftover = [...texts(en.golden), ...texts(en.broken)].filter((text) => HANGUL.test(text));
    expect(leftover).toEqual([]);
  });

  it('망가뜨린 파일이 규칙 대부분을 실제로 거친다', () => {
    const en = run('en');
    const fired = new Set(en.broken.findings.map((f) => f.ruleId));
    expect(fired.size).toBeGreaterThanOrEqual(40);
  });

  it('한국어 결과는 그대로다 — 건수 · 규칙 · 문구 모두', () => {
    const ko = run('ko');
    const en = run('en');
    for (const key of ['golden', 'broken'] as const) {
      expect(en[key].findings.length).toBe(ko[key].findings.length);
      expect(en[key].findings.map((f) => f.ruleId)).toEqual(ko[key].findings.map((f) => f.ruleId));
    }
    // 한국어 쪽은 번역기를 거쳐도 원문 그대로여야 한다
    expect(ko.golden.findings.some((f) => HANGUL.test(f.message))).toBe(true);
    expect(ko.broken.findings.filter((f) => HANGUL.test(f.message)).length).toBe(ko.broken.findings.length);
  });

  it('영어 요청이면 규칙 제목에 한국어가 없다 — 규칙 목록(ruleCatalog)으로도', () => {
    setLangSource(() => 'en');
    expect(ALL_RULES.filter((rule) => HANGUL.test(rule.title)).map((rule) => rule.id)).toEqual([]);
    expect(ruleCatalog().rules.filter((rule) => HANGUL.test(rule.title)).map((rule) => rule.id)).toEqual([]);
    setLangSource(() => 'ko');
    expect(ALL_RULES.every((rule) => HANGUL.test(rule.title))).toBe(true);
  });
});
