/**
 * 결함 주입 테스트.
 *
 * 골든 파일에 실측 결함 8종과 동일한 변형을 넣고, 해당 규칙이 실제로 잡아내는지 확인한다.
 * "0건이 나온다"만으로는 린터가 일하고 있는지 알 수 없으므로 반대 방향을 함께 검증한다.
 */
import { readAasx } from '@aas/aasx';
import type { Environment, Property, Submodel, SubmodelElementCollection } from '@aas/core';
import { ALL_RULES, lint, type LintResult } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

let goldenEnv: Environment;
let goldenPackage: { parts: string[]; contentTypeOverrides: string[]; relationshipTargets: string[] };

beforeAll(() => {
  const pkg = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));
  goldenEnv = pkg.environment;
  goldenPackage = pkg.opc;
});

/** 골든 Environment를 복제해 변형한 뒤 린트한다 */
function lintMutated(
  mutate: (env: Environment) => void,
  options: Parameters<typeof lint>[2] = {},
): LintResult {
  const env = structuredClone(goldenEnv);
  mutate(env);
  return lint(env, ALL_RULES, { package: goldenPackage, ...options });
}

function errorsOf(result: LintResult, ruleId: string): string[] {
  return result.findings
    .filter((f) => f.ruleId === ruleId && f.severity === 'error')
    .map((f) => f.message);
}

/** 서브모델 트리를 깊이 우선으로 훑어 첫 번째 Property를 찾는다 */
function firstProperty(sm: Submodel): Property {
  const stack = [...(sm.submodelElements ?? [])];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.modelType === 'Property') return node as Property;
    if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
  }
  throw new Error(`${sm.idShort}에서 Property를 찾지 못했습니다`);
}

describe('L3 KOSMO — 실측 결함 재현', () => {
  it('KOSMO-AAS-1: defaultThumbnail이 비면 잡는다', () => {
    const result = lintMutated((env) => {
      delete env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail;
    });
    expect(errorsOf(result, 'KOSMO-AAS-1').length).toBe(1);
  });

  it('KOSMO-AAS-1: 썸네일 파트가 실제로 없으면 잡는다', () => {
    const result = lintMutated(
      (env) => {
        env.assetAdministrationShells![0]!.assetInformation.defaultThumbnail = {
          path: '/없는파일.png',
          contentType: 'image/png',
        };
      },
    );
    expect(errorsOf(result, 'KOSMO-AAS-1').length).toBe(1);
    expect(errorsOf(result, 'PKG-THUMB-PART').length).toBe(1);
  });

  it('PKG-THUMB-PART: 확장자 Default로 덮이면 위반이 아니라 참고다 (사업 참조모델 v0.0.1 형태)', () => {
    const pkg = {
      ...goldenPackage,
      contentTypeOverrides: goldenPackage.contentTypeOverrides.filter((p) => p !== '/thumbnail.png'),
      contentTypeDefaults: ['rels', 'xml', 'json', 'png'],
    };
    const result = lint(structuredClone(goldenEnv), ALL_RULES, { package: pkg });
    expect(errorsOf(result, 'PKG-THUMB-PART')).toEqual([]);
    const infos = result.findings.filter((f) => f.ruleId === 'PKG-THUMB-PART' && f.severity === 'info');
    expect(infos.length).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('PKG-THUMB-PART: Default도 Override도 없으면 여전히 위반이다', () => {
    const pkg = {
      ...goldenPackage,
      contentTypeOverrides: goldenPackage.contentTypeOverrides.filter((p) => p !== '/thumbnail.png'),
      contentTypeDefaults: ['rels', 'xml', 'json'],
    };
    const result = lint(structuredClone(goldenEnv), ALL_RULES, { package: pkg });
    expect(errorsOf(result, 'PKG-THUMB-PART').length).toBe(1);
  });

  it('KOSMO-AAS-3: administration이 없으면 Id 형식을 검증할 수 없다고 보고한다', () => {
    const result = lintMutated((env) => {
      delete env.assetAdministrationShells![0]!.administration;
    });
    expect(errorsOf(result, 'KOSMO-AAS-3')).toEqual([
      'Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.',
    ]);
  });

  it('KOSMO-AAS-3: Id 접미가 administration과 어긋나면 잡는다 (실측 2차 결함)', () => {
    const result = lintMutated((env) => {
      const shell = env.assetAdministrationShells![0]!;
      shell.administration = { version: '3', revision: '1' };
    });
    const messages = errorsOf(result, 'KOSMO-AAS-3');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('기대값 3/1');
  });

  it('KOSMO-AAS-4: 필수 서브모델이 빠지면 잡는다', () => {
    const result = lintMutated((env) => {
      env.submodels = env.submodels!.filter((s) => s.idShort !== 'DigitalNameplate');
    });
    const messages = errorsOf(result, 'KOSMO-AAS-4');
    expect(messages.some((m) => m.includes('DigitalNameplate'))).toBe(true);
  });

  it('KOSMO-AAS-4: 서브모델이 9종 이상이면 그 자체로 위반이다', () => {
    const result = lintMutated((env) => {
      const extra = structuredClone(env.submodels![0]!);
      for (let i = 0; i < 3; i++) {
        const copy = structuredClone(extra);
        copy.id = `${extra.id}/dup${i}`;
        copy.idShort = `Extra${i}`;
        env.submodels!.push(copy);
      }
    });
    const messages = errorsOf(result, 'KOSMO-AAS-4');
    expect(messages.some((m) => m.includes('10종'))).toBe(true);
  });

  it('KOSMO-AAS-6: assetKind가 Type이 아니면 잡는다', () => {
    const result = lintMutated((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    });
    expect(errorsOf(result, 'KOSMO-AAS-6')).toHaveLength(1);
  });

  it('KOSMO-SM-3: admin-shell.io IRI는 기본 정책에서 위반이다 (실측 1·3차 결함)', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate' }],
      };
    });
    const findings = result.findings.filter((f) => f.ruleId === 'KOSMO-SM-3');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.policyNote).toContain('이관 대장');
  });

  it('KOSMO-SM-3: key 타입을 Submodel로 바꾸면 basyx 드롭 위험을 경고한다', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.semanticId!.keys[0]!.type = 'Submodel';
    });
    const messages = errorsOf(result, 'KOSMO-SM-3');
    expect(messages.some((m) => m.includes('GlobalReference'))).toBe(true);
    // AASd-122도 함께 잡혀야 한다
    expect(errorsOf(result, 'AASd-121~128').length).toBeGreaterThan(0);
  });

  it('KOSMO-SM-4: kind가 Template이 아니면 잡는다', () => {
    const result = lintMutated((env) => {
      env.submodels![0]!.kind = 'Instance';
    });
    expect(errorsOf(result, 'KOSMO-SM-4')).toHaveLength(1);
  });

  it('SM-DUP-IDSHORT: 같은 이름의 Submodel이 둘이면 경고한다 — 골든은 0건', () => {
    const clean = lintMutated(() => {});
    expect(clean.findings.filter((f) => f.ruleId === 'SM-DUP-IDSHORT')).toHaveLength(0);

    const result = lintMutated((env) => {
      const twin = structuredClone(env.submodels![0]!);
      twin.id = twin.id + '/2/0'; // id는 다르고 이름만 같다 — 가져오기로 생기는 꼴
      env.submodels!.push(twin);
    });
    const dup = result.findings.filter((f) => f.ruleId === 'SM-DUP-IDSHORT');
    expect(dup).toHaveLength(2); // 둘 다 가리킨다 — 어느 쪽을 지울지는 사람이 정한다
    expect(dup[0]!.severity).toBe('warning');
    expect(dup[0]!.message).toContain('DigitalNameplate');
  });

  it('KOSMO-SME-3: 중간 계층 SMC의 semanticId 누락을 잡는다 (실측 4차 결함)', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'OperationalData')!;
      const smc = (sm.submodelElements ?? []).find(
        (e) => e.modelType === 'SubmodelElementCollection',
      ) as SubmodelElementCollection;
      delete smc.semanticId;
    });
    const findings = result.findings.filter(
      (f) => f.ruleId === 'KOSMO-SME-3' && f.message === 'semanticId가 없습니다.',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.elementType).toBe('SubmodelElementCollection');
  });

  it('KOSMO-SME-3: 대응 CD가 없으면 잡는다', () => {
    const result = lintMutated((env) => {
      env.conceptDescriptions = env.conceptDescriptions!.slice(0, 5);
    });
    const messages = errorsOf(result, 'KOSMO-SME-3');
    expect(messages.length).toBeGreaterThan(50);
    expect(messages.some((m) => m.includes('대응하는 ConceptDescription이 없습니다'))).toBe(true);
  });

  it('KOSMO-SME-4: Property 값이 비면 잡는다 (DN·HD는 면제)', () => {
    const result = lintMutated((env) => {
      const td = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      firstProperty(td).value = '';
    });
    expect(errorsOf(result, 'KOSMO-SME-4')).toEqual(['Property에 값이 없습니다.']);
  });

  it('KOSMO-SME-4: DigitalNameplate의 빈 값은 면제된다', () => {
    const result = lintMutated((env) => {
      const dn = env.submodels!.find((s) => s.idShort === 'DigitalNameplate')!;
      firstProperty(dn).value = '';
    });
    expect(errorsOf(result, 'KOSMO-SME-4')).toHaveLength(0);
  });

  it('KOSMO-SME-5: valueType과 dataType이 어긋나면 잡는다 (실측 3차 결함)', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      // 문자열 Property를 boolean으로 바꾸면 CD의 STRING과 충돌한다
      const prop = firstProperty(sm);
      prop.valueType = prop.valueType === 'xs:boolean' ? 'xs:string' : 'xs:boolean';
    });
    const messages = errorsOf(result, 'KOSMO-SME-5');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('valueType과 CD의 dataType이 맞지 않습니다');
  });

  it('KOSMO-CD-4: FILE dataType은 KOSMO에서 거부된다 (실측 4차 결함)', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        dataType?: string;
      };
      content.dataType = 'FILE';
    });
    const messages = errorsOf(result, 'KOSMO-CD-4');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('FILE');
  });

  it('KOSMO-CD-3: 영문 정의가 없으면 잡는다', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: unknown;
      };
      delete content.definition;
      delete cd.description;
    });
    expect(errorsOf(result, 'KOSMO-CD-3')).toHaveLength(1);
  });
});

describe('L2 제약조건', () => {
  it('AASd-022: 형제 요소의 idShort가 겹치면 잡는다', () => {
    const result = lintMutated((env) => {
      const sm = env.submodels!.find((s) => s.idShort === 'TechnicalData')!;
      const elems = sm.submodelElements!;
      const copy = structuredClone(elems[0]!);
      elems.push(copy);
    });
    expect(errorsOf(result, 'AASd-022').length).toBeGreaterThan(0);
  });

  it('AASd-108: 리스트에 이종 타입을 넣으면 잡는다', () => {
    const result = lintMutated((env) => {
      for (const sm of env.submodels ?? []) {
        const stack = [...(sm.submodelElements ?? [])];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.modelType === 'SubmodelElementList' && node.value?.length) {
            node.value.push({
              modelType: 'Property',
              idShort: 'Intruder',
              valueType: 'xs:string',
              value: 'x',
            } as Property);
            return;
          }
          if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
        }
      }
    });
    expect(errorsOf(result, 'AASd-107/108/109/114').length).toBeGreaterThan(0);
  });

  it('AASc-3a-009: MEASURE인데 단위가 없으면 잡는다', () => {
    const result = lintMutated((env) => {
      for (const cd of env.conceptDescriptions ?? []) {
        const content = cd.embeddedDataSpecifications?.[0]?.dataSpecificationContent as {
          dataType?: string;
          unit?: string;
          unitId?: unknown;
        };
        if (content?.dataType === 'REAL_MEASURE') {
          delete content.unit;
          delete content.unitId;
          return;
        }
      }
    });
    expect(errorsOf(result, 'AASc-3a-009')).toHaveLength(1);
  });
});

describe('L1 패키지', () => {
  it('PKG-FILE-URI: 단순 상대경로는 잡는다', () => {
    const result = lintMutated((env) => {
      for (const sm of env.submodels ?? []) {
        const stack = [...(sm.submodelElements ?? [])];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.modelType === 'File') {
            node.value = '/문서명.pdf';
            return;
          }
          if ('value' in node && Array.isArray(node.value)) stack.push(...(node.value as never[]));
        }
      }
    });
    expect(errorsOf(result, 'PKG-FILE-URI')).toHaveLength(1);
  });

  it('PKG-LANG-DUP: 같은 언어 태그가 중복되면 잡는다', () => {
    const result = lintMutated((env) => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: { language: string; text: string }[];
      };
      content.definition = [
        { language: 'en', text: 'Markings' },
        { language: 'en', text: 'Kennzeichnungen' },
      ];
    });
    expect(errorsOf(result, 'PKG-LANG-DUP')).toHaveLength(1);
  });
});

describe('정책 스위치 — 규정 충돌 3건은 숨기지 않고 선택하게 한다', () => {
  it('충돌 ①: idta-preserve면 IDTA IRI를 경고로만 표시한다', () => {
    const mutate = (env: Environment): void => {
      env.submodels![0]!.semanticId = {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/zvei/nameplate/3/0/Nameplate' }],
      };
    };

    const strict = lintMutated(mutate);
    const relaxed = lintMutated(mutate, { policy: { iriConflict: 'idta-preserve' } });

    expect(strict.findings.find((f) => f.ruleId === 'KOSMO-SM-3')!.severity).toBe('error');
    const relaxedFinding = relaxed.findings.find((f) => f.ruleId === 'KOSMO-SM-3')!;
    expect(relaxedFinding.severity).toBe('warning');
    expect(relaxedFinding.policyNote).toContain('KOSMO Validator는 이를 거부');
  });

  it('충돌 ②: allow-empty면 CD 정의 누락을 참고 항목으로 낮춘다', () => {
    const mutate = (env: Environment): void => {
      const cd = env.conceptDescriptions![0]!;
      const content = cd.embeddedDataSpecifications![0]!.dataSpecificationContent as {
        definition?: unknown;
      };
      delete content.definition;
      delete cd.description;
    };

    expect(lintMutated(mutate).findings.find((f) => f.ruleId === 'KOSMO-CD-3')!.severity).toBe('error');
    const relaxed = lintMutated(mutate, { policy: { cdDefinition: 'allow-empty' } });
    expect(relaxed.findings.find((f) => f.ruleId === 'KOSMO-CD-3')!.severity).toBe('info');
  });

  it('충돌 ③: preserve면 언어 태그 중복을 경고로만 표시한다', () => {
    const mutate = (env: Environment): void => {
      const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!
        .dataSpecificationContent as { definition?: { language: string; text: string }[] };
      content.definition = [
        { language: 'en', text: 'A' },
        { language: 'en', text: 'B' },
      ];
    };

    expect(lintMutated(mutate).findings.find((f) => f.ruleId === 'PKG-LANG-DUP')!.severity).toBe('error');
    const relaxed = lintMutated(mutate, { policy: { langTagTypo: 'preserve' } });
    expect(relaxed.findings.find((f) => f.ruleId === 'PKG-LANG-DUP')!.severity).toBe('warning');
  });
});

describe('AASd-120 · AASd-090 — 규격에 있으나 KOSMO가 검사하지 않는 것', () => {
  it('골든 파일은 AASd-120을 실제로 위반한다 — 경고로 드러난다', () => {
    // 🔴 이것이 basyx가 이 파일을 읽지 못하는 이유이고(CLAUDE.md),
    // aas-test-engines 1.0.3이 오류 9건으로 떨어뜨리는 이유다(2026-08-24 실측)
    const result = lintMutated(() => undefined);
    const violations = result.findings.filter((f) => f.ruleId === 'AASd-120');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe('warning'); // 기본 정책
    // KOSMO 제출은 막지 않는다
    expect(result.passed).toBe(true);
  });

  it('정책을 forbid로 올리면 위반이 된다 — 상호운용 우선 배포', () => {
    const result = lintMutated(() => undefined, { policy: { smlChildIdShort: 'forbid' } });
    const violations = result.findings.filter((f) => f.ruleId === 'AASd-120');
    expect(violations[0]!.severity).toBe('error');
    expect(result.passed).toBe(false);
  });

  it('allow면 아예 보고하지 않는다', () => {
    const result = lintMutated(() => undefined, { policy: { smlChildIdShort: 'allow' } });
    expect(result.findings.filter((f) => f.ruleId === 'AASd-120')).toHaveLength(0);
  });

  it('AASd-090: category가 허용값 밖이면 잡는다. 비어 있으면 무관하다', () => {
    const withBad = lintMutated((env) => {
      firstProperty(env.submodels![0]!).category = 'DOCUMENT';
    });
    expect(errorsOf(withBad, 'AASd-090')).toHaveLength(1);

    const withGood = lintMutated((env) => {
      firstProperty(env.submodels![0]!).category = 'PARAMETER';
    });
    expect(errorsOf(withGood, 'AASd-090')).toHaveLength(0);

    // 골든 파일은 category를 쓰지 않는다 — 그래서 지금까지 드러나지 않았다
    expect(errorsOf(lintMutated(() => undefined), 'AASd-090')).toHaveLength(0);
  });
});

describe('충돌 ⑤ — 표준 템플릿의 용어 (AID 도입 중 확인)', () => {
  /** AID처럼 W3C WoT 용어를 semanticId로 갖는 요소 */
  const withStandardTerm = (env: Environment): void => {
    const submodel = env.submodels![0]!;
    submodel.submodelElements!.push({
      modelType: 'Property',
      idShort: 'title',
      valueType: 'xs:string',
      value: 'x',
      semanticId: {
        type: 'ExternalReference',
        keys: [{ type: 'GlobalReference', value: 'https://www.w3.org/2019/wot/td#title' }],
      },
    } as never);
  };

  it('기본(kosmo-first)에서는 CD가 없으므로 위반이다', () => {
    const result = lintMutated(withStandardTerm);
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(1);
  });

  it('preserve에서는 참고로만 남고 교정 대상에서 빠진다', () => {
    // 공식 템플릿(IDTA-02017)은 CD를 제공하지 않는다(실측 CD 0개).
    // 교정하면 표준 용어가 자체 IRI로 덮여 템플릿의 의미가 깨진다 — KTL §7과도 충돌
    const result = lintMutated(withStandardTerm, {
      policy: { standardTemplateSemantics: 'preserve' },
    });
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(0);

    const note = result.findings.find((f) => f.ruleId === 'KOSMO-SME-3' && f.severity === 'info')!;
    expect(note.fixable).toBe(false); // 「고치기」가 손대지 않는다
    expect(note.policyNote).toContain('KOSMO Validator');
  });

  it('우리가 만든 자체 IRI는 preserve에서도 여전히 위반이다 — 완화가 아니라 구분이다', () => {
    const result = lintMutated(
      (env) => {
        const property = firstProperty(env.submodels![0]!);
        property.semanticId = {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: 'https://www.smart-factory.kr/ids/cd/없는것/1/0' }],
        };
      },
      { policy: { standardTemplateSemantics: 'preserve' } },
    );
    expect(errorsOf(result, 'KOSMO-SME-3')).toHaveLength(1);
  });
});
