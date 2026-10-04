/**
 * L3 — KOSMO 사업 규칙 · ConceptDescription #1 ~ #5.
 *
 * CD#3(definition)은 KTL §8과 충돌한다(명세 §5 충돌 ②) — 정책 cdDefinition으로 갈린다.
 * CD#4는 AASc-3a-004 열거보다 좁다. aas-core3.1은 FILE을 통과시키지만 KOSMO는 거부한다.
 */
import type { ConceptDescription } from '@aas/core';
import type { LintContext, Rule, Severity } from '../types.js';
import {
  hasLanguage,
  iec61360Of,
  isAllowedId,
  isIdtaIri,
  isValidIdShort,
  KOSMO_ALLOWED_DATA_TYPES,
} from '../util.js';

const SOURCE = '02_Validator_대응규칙.md §1.2 · §2⑥⑦';

function eachCd(
  ctx: LintContext,
  fn: (cd: ConceptDescription, pointer: string, kosmoPath: string, key: string) => void,
): void {
  (ctx.environment.conceptDescriptions ?? []).forEach((cd, i) => {
    const key = cd.idShort ?? cd.id;
    fn(cd, `/conceptDescriptions/${i}`, `/conceptDescriptions/${i}(${key})`, key);
  });
}

export const kosmoCd1IdShort: Rule = {
  id: 'KOSMO-CD-1',
  layer: 'L3',
  title: 'ConceptDescription idShort 설정 및 명명 규칙 검사',
  source: SOURCE,
  check(ctx, report) {
    eachCd(ctx, (cd, pointer, kosmoPath, key) => {
      if (!cd.idShort) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: 'ConceptDescription에 idShort가 없습니다.',
          remedy: '대응하는 요소의 idShort와 같은 이름을 지정하십시오.',
          fixable: true,
        });
        return;
      }
      if (!isValidIdShort(cd.idShort)) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: `idShort가 명명 규칙에 맞지 않습니다: ${cd.idShort}`,
          remedy: '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오.',
          fixable: true,
        });
      }
    });
  },
};

export const kosmoCd2IdFormat: Rule = {
  id: 'KOSMO-CD-2',
  layer: 'L3',
  title: 'ConceptDescription Id 형식 검사 — IRDI 또는 자체 IRI 화이트리스트',
  source: `${SOURCE} (실측 1·3차 위반)`,
  check(ctx, report) {
    const { policy } = ctx;
    eachCd(ctx, (cd, pointer, kosmoPath, key) => {
      if (isAllowedId(cd.id, policy)) return;

      const idta = isIdtaIri(cd.id);
      const severity: Severity =
        idta && policy.iriConflict === 'idta-preserve' ? 'warning' : 'error';

      report({
        severity,
        elementType: 'ConceptDescription',
        key,
        pointer: `${pointer}/id`,
        kosmoPath: `${kosmoPath}/id`,
        message: `CD의 id가 허용 목록 밖입니다: ${cd.id}`,
        remedy:
          `IRDI(${policy.irdiPrefixes.join(' / ')}) 또는 ${policy.iriBase}/cd/{변수명}/{version}/{revision} 형식으로 바꾸십시오. ` +
          '카테고리 자리(cd)에 장비명을 쓰면 안 됩니다.',
        fixable: true,
        ...(idta
          ? {
              policyNote:
                policy.iriConflict === 'idta-preserve'
                  ? 'IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다.'
                  : 'IDTA 공식 IRI이지만 정책(kosmo-first)에 따라 위반으로 봅니다. 교정 시 이관 대장에 원본 IRI를 기록하십시오.',
            }
          : {}),
      });
    });
  },
};

export const kosmoCd3Definition: Rule = {
  id: 'KOSMO-CD-3',
  layer: 'L3',
  title: 'definition/description 작성 검사 — 영문 정의 필수',
  source: `${SOURCE} (실측 3차 위반, KTL §8과 충돌)`,
  check(ctx, report) {
    const relaxed = ctx.policy.cdDefinition === 'allow-empty';
    eachCd(ctx, (cd, pointer, kosmoPath, key) => {
      const content = iec61360Of(cd);
      const hasEnDefinition = hasLanguage(content?.definition, 'en');
      const hasDescription = (cd.description?.length ?? 0) > 0;
      if (hasEnDefinition || hasDescription) return;

      report({
        severity: relaxed ? 'info' : 'error',
        elementType: 'ConceptDescription',
        key,
        pointer: `${pointer}/embeddedDataSpecifications/0/dataSpecificationContent/definition`,
        kosmoPath: `${kosmoPath}/definition`,
        message: '영문(en) definition 또는 description이 없습니다.',
        remedy:
          '개발계획서 원문의 정의를 그대로 인용해 en 태그로 채우십시오. ' +
          '정의를 창작하지 마십시오.',
        fixable: false,
        policyNote: relaxed
          ? 'KTL §8(정의 없으면 공란 유지)을 따르는 정책(allow-empty)이라 참고 항목으로만 표시했습니다. KOSMO Validator는 이를 위반으로 봅니다.'
          : 'KTL §8은 임의 입력을 금지하나 KOSMO는 영문 정의를 요구합니다. 정책(require-en)에 따라 위반으로 봅니다.',
      });
    });
  },
};

export const kosmoCd4DataType: Rule = {
  id: 'KOSMO-CD-4',
  layer: 'L3',
  title: 'DataType 설정 검사 — 존재 여부 및 KOSMO 허용 목록',
  source: `${SOURCE} (실측 3·4차 위반)`,
  check(ctx, report) {
    eachCd(ctx, (cd, pointer, kosmoPath, key) => {
      const content = iec61360Of(cd);
      const contentPointer = `${pointer}/embeddedDataSpecifications/0/dataSpecificationContent`;

      if (!content) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${pointer}/embeddedDataSpecifications`,
          kosmoPath: `${kosmoPath}/embeddedDataSpecifications`,
          message: 'IEC 61360 데이터 명세가 없습니다.',
          remedy: 'DataSpecificationIec61360 내용을 embeddedDataSpecifications에 추가하십시오.',
          fixable: true,
        });
        return;
      }

      if (!content.dataType) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${contentPointer}/dataType`,
          kosmoPath: `${kosmoPath}/dataType`,
          message: 'dataType이 설정되어 있지 않습니다.',
          remedy: '대응 Property의 valueType에 맞는 dataType을 지정하십시오.',
          fixable: true,
        });
        return;
      }

      if (!KOSMO_ALLOWED_DATA_TYPES.has(content.dataType)) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${contentPointer}/dataType`,
          kosmoPath: `${kosmoPath}/dataType`,
          message: `유효하지 않은 dataType 값입니다: ${content.dataType}`,
          remedy:
            'STRING으로 정규화하십시오. FILE·BLOB·HTML은 AASc-3a-006에서는 허용되지만 KOSMO는 더 좁게 봅니다.',
          fixable: true,
        });
      }
    });
  },
};

export const kosmoCd5Duplicate: Rule = {
  id: 'KOSMO-CD-5',
  layer: 'L3',
  title: 'ConceptDescription id·idShort 중복 검사',
  source: SOURCE,
  check(ctx, report) {
    const byId = new Map<string, number[]>();
    const byIdShort = new Map<string, number[]>();
    const cds = ctx.environment.conceptDescriptions ?? [];

    cds.forEach((cd, i) => {
      byId.set(cd.id, [...(byId.get(cd.id) ?? []), i]);
      if (cd.idShort) byIdShort.set(cd.idShort, [...(byIdShort.get(cd.idShort) ?? []), i]);
    });

    for (const [id, indices] of byId) {
      if (indices.length < 2) continue;
      for (const i of indices.slice(1)) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key: cds[i]?.idShort ?? id,
          pointer: `/conceptDescriptions/${i}/id`,
          kosmoPath: `/conceptDescriptions/${i}(${cds[i]?.idShort ?? id})/id`,
          message: `동일한 id를 가진 ConceptDescription이 ${indices.length}건 있습니다: ${id}`,
          remedy: '중복된 CD를 하나로 합치십시오.',
          fixable: true,
        });
      }
    }

    for (const [idShort, indices] of byIdShort) {
      if (indices.length < 2) continue;

      /*
       * 🔴 **모두 외부 표준 사전(IRDI) 항목이면 이것은 결함이 아니다.**
       *
       * 실측(골든 파일): `ManufacturerName`이 IEC CDD(`0112/2///61987#ABA565#009`)와
       * ECLASS(`0173-1#02-AAO677#004`) 두 벌로 있고, **둘 다 실제로 참조된다** —
       * DigitalNameplate와 TechnicalData가 각각 다른 사전을 쓰기 때문이다.
       * 서로 다른 사전이 같은 개념에 같은 이름을 붙인 것이지 우리가 잘못 만든 게 아니다.
       *
       * 그리고 **고칠 수도 없다.** 합치면 한쪽 서브모델의 semanticId가 표준 사전을
       * 안 가리키게 되고, 이름을 바꾸면 사전 원본과 어긋난다. IRDI는 남의 표준이라
       * 우리가 손댈 것이 아니다(SME-5에서도 외부 CD는 교정 방향이 반대다).
       *
       * 🔴 그래서 **경고로 띄우지 않는다.** 사람이 할 수 있는 일이 없는데 경고가 떠 있으면
       *    고치려 들다가 못 고치고 만다 — 그건 지적이 아니라 잡음이다(2026-09-01 사용자 지적).
       *    사실은 남겨야 하므로 `info`로 낮추고, **고치지 말라고 분명히 적는다.**
       */
      const allExternal = indices.every((i) => {
        const id = cds[i]?.id;
        return id !== undefined && ctx.policy.irdiPrefixes.some((prefix) => id.startsWith(prefix));
      });

      for (const i of indices.slice(1)) {
        report({
          severity: allExternal ? 'info' : 'warning',
          elementType: 'ConceptDescription',
          key: idShort,
          pointer: `/conceptDescriptions/${i}/idShort`,
          kosmoPath: `/conceptDescriptions/${i}(${idShort})/idShort`,
          message: allExternal
            ? `같은 이름의 표준 사전 항목이 ${indices.length}곳에 있습니다: ${idShort}`
            : `동일한 idShort를 가진 ConceptDescription이 ${indices.length}건 있습니다: ${idShort}`,
          remedy: allExternal
            ? '🔴 고치지 마십시오. 서로 다른 표준 사전(IEC CDD·ECLASS 등)이 같은 개념에 같은 이름을 붙인 것이고, 각각 다른 서브모델이 참조합니다. 합치면 한쪽이 표준 사전을 못 가리키게 됩니다.'
            : '서로 다른 개념이면 idShort를 구분하고, 같은 개념이면 하나로 합치십시오.',
          fixable: false,
          ...(allExternal
            ? {
                policyNote:
                  '외부 표준 사전(IRDI) 항목이라 우리가 손댈 대상이 아닙니다. 사실만 알리고 지적하지 않습니다.',
              }
            : {}),
        });
      }
    }
  },
};

export const KOSMO_CD_RULES: readonly Rule[] = [
  kosmoCd1IdShort,
  kosmoCd2IdFormat,
  kosmoCd3Definition,
  kosmoCd4DataType,
  kosmoCd5Duplicate,
];
