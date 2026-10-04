/**
 * Quick Fix 검증.
 *
 * 결함 주입 테스트(injection.test.ts)와 짝을 이룬다 — 저쪽이 "잡아내는가"를 보고,
 * 여기는 "고친 결과가 실제로 통과하는가"를 본다.
 * 교정이 다른 규칙을 새로 깨뜨리면 after.error가 0이 아니게 되므로 회귀가 바로 드러난다.
 */
import { readAasx, writeAasx } from '@aas/aasx';
import type {
  ConceptDescription,
  Environment,
  File as AasFile,
  Property,
  Submodel,
  SubmodelElement,
} from '@aas/core';
import { ALL_RULES, lint, lintAndFix, type ApplyFixOptions, type LintAndFixResult } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let golden: ReturnType<typeof readAasx>;

beforeAll(() => {
  golden = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));
});

/** 골든 Environment를 복제해 결함을 주입한 뒤 린트 → 교정 → 재린트한다 */
function fixMutated(
  mutate: (env: Environment) => void,
  options: ApplyFixOptions = {},
): LintAndFixResult & { env: Environment } {
  const env = structuredClone(golden.environment);
  mutate(env);
  const result = lintAndFix(env, { package: golden.opc, ...options });
  // 주입이 실제로 위반을 만들었는지 확인한다 — 이게 없으면 통과가 공회전일 수 있다
  expect(result.before.countBySeverity.error).toBeGreaterThan(0);
  return { ...result, env: result.environment };
}

function errorsOf(findings: readonly { ruleId: string; severity: string }[], ruleId: string): number {
  return findings.filter((f) => f.ruleId === ruleId && f.severity === 'error').length;
}

/** 교정 결과에 남은 위반을 사람이 읽을 형태로 — 실패 시 원인이 바로 보이게 한다 */
function remaining(result: LintAndFixResult): string {
  return result.after.findings
    .filter((f) => f.severity === 'error')
    .map((f) => `${f.ruleId} @ ${f.kosmoPath}: ${f.message}`)
    .join('\n');
}

function allElements(sm: Submodel): SubmodelElement[] {
  const out: SubmodelElement[] = [];
  const walk = (items: SubmodelElement[]): void => {
    for (const node of items) {
      out.push(node);
      const children = (node as { value?: unknown }).value;
      if (Array.isArray(children)) walk(children as SubmodelElement[]);
      const statements = (node as { statements?: SubmodelElement[] }).statements;
      if (statements) walk(statements);
    }
  };
  walk(sm.submodelElements ?? []);
  return out;
}

function findElement(
  env: Environment,
  predicate: (node: SubmodelElement, sm: Submodel) => boolean,
): { node: SubmodelElement; submodel: Submodel } {
  for (const sm of env.submodels ?? []) {
    for (const node of allElements(sm)) {
      if (predicate(node, sm)) return { node, submodel: sm };
    }
  }
  throw new Error('조건에 맞는 요소를 찾지 못했습니다');
}

describe('Quick Fix — 실측 결함 8종 교정', () => {
  it('KOSMO-AAS-1: 썸네일 누락을 패키지 파트에서 찾아 채운다', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail).toEqual({
      path: '/thumbnail.png',
      contentType: 'image/png',
    });
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-1: 패키지 정보 없이는 고치지 않고 이유를 남긴다', () => {
    const env = structuredClone(golden.environment);
    delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    const r = lintAndFix(env); // package 미지정
    expect(r.applied.filter((a) => a.ruleId === 'KOSMO-AAS-1')).toHaveLength(0);
    expect(r.skipped.some((s) => s.ruleId === 'KOSMO-AAS-1' && s.reason.includes('패키지 정보'))).toBe(true);
  });

  it('KOSMO-AAS-3: administration이 없으면 id 접미에서 만들어 낸다', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.administration;
    });
    expect(r.env.assetAdministrationShells![0]!.administration).toEqual({ version: '1', revision: '0' });
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-2: id 접미가 어긋나면 id를 고치고 AAS의 참조까지 갱신한다', () => {
    const target = golden.environment.submodels!.findIndex((s) => s.idShort === 'OperationalData');
    const oldId = golden.environment.submodels![target]!.id;

    const r = fixMutated((env) => {
      env.submodels![target]!.administration = { version: '2', revision: '3' };
    });

    const fixed = r.env.submodels![target]!;
    expect(fixed.id.endsWith('/2/3')).toBe(true);
    // 참조 무결성 — AAS의 submodels[]와 자기 semanticId가 함께 따라와야 한다
    const refs = (r.env.assetAdministrationShells![0]!.submodels ?? []).flatMap((ref) =>
      ref.keys.map((k) => k.value),
    );
    expect(refs).toContain(fixed.id);
    expect(refs).not.toContain(oldId);
    expect(fixed.semanticId!.keys[0]!.value).toBe(fixed.id);
    // 이관 대장에 원본이 남는다
    expect(r.relocations[fixed.id]).toBe(oldId);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-5: globalAssetId를 규약대로 만든다', () => {
    const r = fixMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.globalAssetId;
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.globalAssetId).toBe(
      'https://www.smart-factory.kr/ids/asset/RollFormingMachine/1/0',
    );
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-AAS-6 · SM-4: Type · Template으로 되돌린다', () => {
    const r = fixMutated((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![0]!.kind = 'Instance';
    });
    expect(r.env.assetAdministrationShells![0]!.assetInformation.assetKind).toBe('Type');
    expect(r.env.submodels![0]!.kind).toBe('Template');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-3: 허용 목록 밖 semanticId를 자기 id로 옮기고 원본을 대장에 남긴다', () => {
    const idtaIri = 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate';
    const r = fixMutated((env) => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: idtaIri }],
      };
    });
    const sm = r.env.submodels![0]!;
    expect(sm.semanticId!.keys[0]!.value).toBe(sm.id);
    expect(r.relocations[sm.id]).toBe(idtaIri);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SM-3: 키 타입이 Submodel로 바뀐 것을 GlobalReference로 되돌린다 (basyx 드롭 방지)', () => {
    const r = fixMutated((env) => {
      env.submodels![0]!.semanticId!.keys[0]!.type = 'Submodel';
    });
    expect(r.env.submodels![0]!.semanticId!.keys[0]!.type).toBe('GlobalReference');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-CD-2: 허용 목록 밖 CD id를 자체 IRI 규약으로 옮기고 참조를 갱신한다', () => {
    const index = golden.environment.conceptDescriptions!.findIndex(
      (cd) => cd.id === 'https://www.smart-factory.kr/ids/cd/AlarmActive/1/0',
    );
    const canonical = golden.environment.conceptDescriptions![index]!.id;

    const r = fixMutated((env) => {
      const cd = env.conceptDescriptions![index]!;
      const oldId = cd.id;
      cd.id = 'https://example.com/AlarmActive';
      // 참조도 함께 옮겨 둔다 — 실제 이관 사고와 같은 모양
      for (const sm of env.submodels ?? []) {
        for (const node of allElements(sm)) {
          const key = node.semanticId?.keys?.[0];
          if (key?.value === oldId) key.value = cd.id;
        }
      }
    });

    const cd = r.env.conceptDescriptions![index]!;
    expect(cd.id).toBe(canonical);
    expect(r.relocations[canonical]).toBe('https://example.com/AlarmActive');
    // 참조가 따라왔는지 — 어디에도 옛 id가 남으면 안 된다
    expect(JSON.stringify(r.env)).not.toContain('https://example.com/AlarmActive');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-3: semanticId가 없으면 규약대로 붙이고 CD가 없으면 만든다', () => {
    const { node } = findElement(golden.environment, (n) => n.modelType === 'Property');
    const idShort = node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      delete target.node.semanticId;
    });

    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    const semantic = fixed.node.semanticId!.keys[0]!.value;
    expect(semantic).toContain('/ids/cd/');
    expect(r.env.conceptDescriptions!.some((cd) => cd.id === semantic)).toBe(true);
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-3: idShort 없는 리스트 자식의 CD는 부모 리스트 이름의 단수형(Markings → Marking)으로 만든다', () => {
    // AASd-120 교정 뒤 모습 — idShort 없는 리스트 자식의 semanticId가 가리키는 CD가 없다.
    // 전에는 "idShort가 없어 ConceptDescription을 만들 수 없습니다"로 건너뛰어 단추 숫자와 팝업이 어긋났다(2026-09-11)
    let semantic = '';
    const r = fixMutated((env) => {
      const { node } = findElement(env, (n) => n.idShort === 'Markings' && n.modelType === 'SubmodelElementList');
      const child = (node as { value?: SubmodelElement[] }).value![0]!;
      semantic = child.semanticId!.keys[0]!.value;
      delete child.idShort;
      env.conceptDescriptions = env.conceptDescriptions!.filter((cd) => cd.id !== semantic);
    });
    const created = r.env.conceptDescriptions!.find((cd) => cd.id === semantic);
    expect(created?.idShort).toBe('Marking');
    expect(r.skipped.filter((s) => s.ruleId === 'KOSMO-SME-3')).toEqual([]);
    expect(remaining(r)).toBe('');
  });

  it('AASd-109: Property 리스트에 valueTypeListElement가 없으면 자식들의 valueType으로 채운다', () => {
    const r = fixMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      sm.submodelElements!.push({
        modelType: 'SubmodelElementList',
        idShort: 'SpindleTemps',
        typeValueListElement: 'Property',
        value: [
          { modelType: 'Property', valueType: 'xs:double', value: '41.5' },
          { modelType: 'Property', valueType: 'xs:double', value: '42.0' },
        ],
      } as never);
    });
    const list = findElement(r.env, (n) => n.idShort === 'SpindleTemps').node as { valueTypeListElement?: string };
    expect(list.valueTypeListElement).toBe('xs:double');
    expect(r.after.findings.filter((f) => f.ruleId === 'AASd-107/108/109/114' && f.severity === 'error')).toEqual([]);
  });

  it('KOSMO-SME-3: CD가 통째로 없어진 경우 골든 파일과 같은 모양으로 새로 만든다', () => {
    const { node } = findElement(
      golden.environment,
      (n) => n.modelType === 'Property' && (n.semanticId?.keys[0]?.value ?? '').includes('/ids/cd/'),
    );
    const semantic = node.semanticId!.keys[0]!.value;

    const r = fixMutated((env) => {
      env.conceptDescriptions = env.conceptDescriptions!.filter((cd) => cd.id !== semantic);
    });

    const created = r.env.conceptDescriptions!.find((cd) => cd.id === semantic);
    expect(created).toBeDefined();
    expect(created!.idShort).toBe(node.idShort);
    const content = created!.embeddedDataSpecifications![0]!.dataSpecificationContent as {
      preferredName: { language: string; text: string }[];
      dataType?: string;
    };
    expect(content.preferredName[0]).toEqual({ language: 'en', text: node.idShort });
    expect(content.dataType).toBeDefined();
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-5: 자체 CD면 CD의 dataType을 Property에 맞춘다', () => {
    const { node } = findElement(
      golden.environment,
      (n) =>
        n.modelType === 'Property' &&
        (n as Property).valueType === 'xs:string' &&
        (n.semanticId?.keys[0]?.value ?? '').includes('/ids/cd/'),
    );
    const semantic = node.semanticId!.keys[0]!.value;
    const idShort = node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      (target.node as Property).valueType = 'xs:boolean';
    });

    const cd = r.env.conceptDescriptions!.find((c) => c.id === semantic)!;
    const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as { dataType?: string };
    expect(content.dataType).toBe('BOOLEAN');
    // 우리 쪽 valueType은 건드리지 않는다
    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    expect((fixed.node as Property).valueType).toBe('xs:boolean');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-SME-5: 외부 표준 사전(IRDI) CD면 반대로 Property의 valueType을 맞춘다', () => {
    // IRDI CD를 가리키는 Property를 골라 valueType만 어긋나게 만든다
    const found = findElement(
      golden.environment,
      (n) => n.modelType === 'Property' && (n.semanticId?.keys[0]?.value ?? '').startsWith('0112/'),
    );
    const idShort = found.node.idShort!;
    const semantic = found.node.semanticId!.keys[0]!.value;
    const cd = golden.environment.conceptDescriptions!.find((c) => c.id === semantic)!;
    const dataType = (cd.embeddedDataSpecifications![0]!.dataSpecificationContent as { dataType?: string })
      .dataType;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'Property');
      (target.node as Property).valueType = 'xs:boolean';
    });

    const fixedCd = r.env.conceptDescriptions!.find((c) => c.id === semantic)!;
    const fixedContent = fixedCd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
      dataType?: string;
    };
    // 외부 CD 원본은 그대로 두고
    expect(fixedContent.dataType).toBe(dataType);
    // 우리 쪽 valueType이 바뀐다
    const fixedProp = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'Property');
    expect((fixedProp.node as Property).valueType).not.toBe('xs:boolean');
    expect(remaining(r)).toBe('');
  });

  it('KOSMO-CD-4: 허용 목록 밖 dataType을 STRING으로 정규화한다', () => {
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as { dataType?: string };
      content.dataType = 'FILE';
    });
    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as { dataType?: string };
    expect(content.dataType).toBe('STRING');
    expect(remaining(r)).toBe('');
  });

  it('🔴 AASc-3a-009: 단위를 지어내지 않고 dataType을 COUNT로 낮춘다', () => {
    // 「12.5」가 kW인지 A인지 우리는 모른다 — 틀린 단위는 안 붙은 것보다 위험하다
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as { dataType?: string; unit?: string };
      content.dataType = 'REAL_MEASURE';
      delete content.unit;
    });
    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as { dataType?: string; unit?: string };
    expect(content.dataType).toBe('REAL_COUNT');
    // 단위를 만들어 넣지 않았다
    expect(content.unit).toBeUndefined();
    expect(remaining(r)).toBe('');
    // 되돌리라는 말을 남긴다 — 사람이 판단할 자리다
    expect(r.applied.some((a) => a.description.includes('되돌리십시오'))).toBe(true);
  });

  it('AASc-3a-009: 단위가 이미 있으면 애초에 지적되지 않는다', () => {
    // 🔴 fixMutated를 쓰지 않는다 — 그건 「위반이 생겼는지」를 먼저 확인하는 도구인데
    //    여기서 확인할 것은 정반대로 **위반이 안 생기는 것**이다
    const env = structuredClone(golden.environment);
    const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as { dataType?: string; unit?: string };
    content.dataType = 'REAL_MEASURE';
    content.unit = 'rpm';
    const r = lintAndFix(env, { package: golden.opc });
    expect(errorsOf(r.before.findings, 'AASc-3a-009')).toBe(0);
    expect(content.dataType).toBe('REAL_MEASURE');
  });

  it('PKG-FILE-URI: 상대경로 File.value에 file:// 스킴을 붙인다', () => {
    const found = findElement(golden.environment, (n) => n.modelType === 'File');
    const idShort = found.node.idShort!;

    const r = fixMutated((env) => {
      const target = findElement(env, (n) => n.idShort === idShort && n.modelType === 'File');
      (target.node as AasFile).value = 'suppl/manual.pdf';
    });

    const fixed = findElement(r.env, (n) => n.idShort === idShort && n.modelType === 'File');
    expect((fixed.node as AasFile).value).toBe('file:///suppl/manual.pdf');
    expect(remaining(r)).toBe('');
  });

  it('PKG-LANG-DUP: 중복 언어 태그 중 뒤엣것만 지우고 텍스트는 손대지 않는다', () => {
    const r = fixMutated((env) => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as { preferredName: { language: string; text: string }[] };
      content.preferredName.push({ language: 'en', text: '나중에 들어온 오타본' });
    });

    const content = r.env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
      .dataSpecificationContent as { preferredName: { language: string; text: string }[] };
    expect(content.preferredName.filter((s) => s.language === 'en')).toHaveLength(1);
    expect(content.preferredName.some((s) => s.text === '나중에 들어온 오타본')).toBe(false);
    expect(remaining(r)).toBe('');
  });
});

describe('Quick Fix — 계약', () => {
  it('입력 Environment를 변경하지 않는다', () => {
    const env = structuredClone(golden.environment);
    const snapshot = JSON.stringify(env);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    const mutated = JSON.stringify(env);

    lintAndFix(env, { package: golden.opc });
    expect(JSON.stringify(env)).toBe(mutated);
    expect(mutated).not.toBe(snapshot); // 주입이 실제로 반영됐는지 확인
  });

  it('교정할 것이 없으면 한 바퀴만 돌고 끝난다', () => {
    const r = lintAndFix(golden.environment, { package: golden.opc });
    expect(r.applied).toHaveLength(0);
    expect(r.rounds).toBe(1);
    expect(r.after.countBySeverity.error).toBe(0);
  });

  it('교정기가 없는 규칙은 조용히 넘기지 않고 이유를 남긴다', () => {
    // KOSMO-CD-5(중복 id)는 fixable이지만 자동 교정 대상이 아니다 — 사람이 합쳐야 한다
    const r = fixMutated((env) => {
      const cd = structuredClone(env.conceptDescriptions![0]!) as ConceptDescription;
      env.conceptDescriptions!.push(cd);
    });
    expect(errorsOf(r.after.findings, 'KOSMO-CD-5')).toBeGreaterThan(0);
    expect(r.skipped.some((s) => s.ruleId === 'KOSMO-CD-5' && s.reason.includes('자동 교정기'))).toBe(true);
  });

  it('한 번에 다 드러나지 않는 결함도 반복으로 수렴시킨다', () => {
    const r = fixMutated((env) => {
      const shell = env.assetAdministrationShells![0]!;
      shell.assetInformation.assetKind = 'Instance';
      delete shell.assetInformation.globalAssetId;
      delete shell.assetInformation.defaultThumbnail;
      delete env.submodels![0]!.administration; // administration을 만든 뒤에야 id 검사가 열린다
      env.submodels![1]!.kind = 'Instance';
      env.submodels![2]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/x/1/0' }],
      };
    });
    expect(remaining(r)).toBe('');
    expect(r.before.countBySeverity.error).toBeGreaterThan(0);
    expect(r.applied.length).toBeGreaterThanOrEqual(6);
    expect(r.rounds).toBeLessThanOrEqual(5);
  });

  it('교정 결과가 AASX로 저장돼 다시 읽어도 위반 0건이다', () => {
    const env = structuredClone(golden.environment);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    delete env.assetAdministrationShells![0]!.assetInformation.globalAssetId;
    env.submodels![0]!.kind = 'Instance';

    const fixed = lintAndFix(env, { package: golden.opc });
    const bytes = writeAasx({ ...golden, environment: fixed.environment });
    const reread = readAasx(bytes);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });

    expect(result.countBySeverity.error).toBe(0);
    expect(result.passed).toBe(true);
  });
});

describe('Quick Fix — 규격 준수(AASd-120 · AASd-090)', () => {
  it('SML 자식의 idShort를 지운다 — 표준 도구가 통과하는 형태로', () => {
    const env = structuredClone(golden.environment);
    const before = lint(env, ALL_RULES, {
      package: golden.opc,
      policy: { smlChildIdShort: 'forbid' },
    });
    expect(before.countBySeverity.error).toBeGreaterThan(0);

    const result = lintAndFix(env, {
      package: golden.opc,
      policy: { smlChildIdShort: 'forbid' },
    });
    expect(result.after.countBySeverity.error).toBe(0);
    expect(result.applied.some((a) => a.ruleId === 'AASd-120')).toBe(true);
    // 지운 값은 기록에 남는다 — 되돌릴 수 있어야 한다
    const applied = result.applied.find((a) => a.ruleId === 'AASd-120')!;
    expect(applied.before).toBe('MarkingsEntry_0');

    // KOSMO 규칙은 그대로 0건 — 지워도 제출에 영향이 없다
    const kosmo = lint(result.environment, ALL_RULES, { package: golden.opc });
    expect(kosmo.countBySeverity.error).toBe(0);
  });

  it('허용값 밖 category는 지운다 — 무엇으로 바꿀지는 사람이 정한다', () => {
    const r = fixMutated((env) => {
      const property = findElement(env, (n) => n.modelType === 'Property').node;
      property.category = 'DOCUMENT';
    });
    expect(remaining(r)).toBe('');
    const applied = r.applied.find((a) => a.ruleId === 'AASd-090')!;
    expect(applied.before).toBe('DOCUMENT');
    expect(applied.after).toBeUndefined();
  });
});
