/**
 * L3 — KOSMO project rules · ConceptDescription #1 to #5.
 *
 * CD#3 (definition) conflicts with KTL §8 (spec §5 conflict ②) — resolved by the cdDefinition policy.
 * CD#4 is narrower than the AASc-3a-004 enumeration. aas-core3.1 accepts FILE, but KOSMO rejects it.
 */
import type { ConceptDescription } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { LintContext, Rule, Severity } from '../types.js';
import {
  hasLanguage,
  iec61360Of,
  isAllowedId,
  isIdtaIri,
  KOSMO_ALLOWED_DATA_TYPES,
} from '../util.js';
import { idShortFits, idShortRemedyV30, mayBe } from '../version.js';

// i18n-ignore — source document file name
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
  get title() {
    return tr('ConceptDescription idShort 설정 및 명명 규칙 검사');
  },
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
          message: tr('ConceptDescription에 idShort가 없습니다.'),
          remedy: tr('대응하는 요소의 idShort와 같은 이름을 지정하십시오.'),
          fixable: true,
        });
        return;
      }
      if (!idShortFits(ctx, cd.idShort)) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: fill(tr('idShort가 명명 규칙에 맞지 않습니다: {0}'), { 0: cd.idShort }),
          remedy: !mayBe(ctx, '3.1') ? idShortRemedyV30() : tr('영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오.'),
          fixable: true,
        });
      }
    });
  },
};

export const kosmoCd2IdFormat: Rule = {
  id: 'KOSMO-CD-2',
  layer: 'L3',
  get title() {
    return tr('ConceptDescription Id 형식 검사 — IRDI 또는 자체 IRI 화이트리스트');
  },
  get source() {
    return fill(tr('{0} (실측 1·3차 위반)'), { 0: SOURCE });
  },
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
        message: fill(tr('CD의 id가 허용 목록 밖입니다: {0}'), { 0: cd.id }),
        remedy: fill(
          tr('IRDI({0}) 또는 {1}/cd/{변수명}/{version}/{revision} 형식으로 바꾸십시오. 카테고리 자리(cd)에 장비명을 쓰면 안 됩니다.'),
          { 0: policy.irdiPrefixes.join(' / '), 1: policy.iriBase },
        ),
        fixable: true,
        ...(idta
          ? {
              policyNote:
                policy.iriConflict === 'idta-preserve'
                  ? tr('IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다.')
                  : tr('IDTA 공식 IRI이지만 정책(kosmo-first)에 따라 위반으로 봅니다. 교정 시 이관 대장에 원본 IRI를 기록하십시오.'),
            }
          : {}),
      });
    });
  },
};

export const kosmoCd3Definition: Rule = {
  id: 'KOSMO-CD-3',
  layer: 'L3',
  get title() {
    return tr('definition/description 작성 검사 — 영문 정의 필수');
  },
  get source() {
    return fill(tr('{0} (실측 3차 위반, KTL §8과 충돌)'), { 0: SOURCE });
  },
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
        message: tr('영문(en) definition 또는 description이 없습니다.'),
        remedy: tr('개발계획서 원문의 정의를 그대로 인용해 en 태그로 채우십시오. 정의를 창작하지 마십시오.'),
        fixable: false,
        policyNote: relaxed
          ? tr('KTL §8(정의 없으면 공란 유지)을 따르는 정책(allow-empty)이라 참고 항목으로만 표시했습니다. KOSMO Validator는 이를 위반으로 봅니다.')
          : tr('KTL §8은 임의 입력을 금지하나 KOSMO는 영문 정의를 요구합니다. 정책(require-en)에 따라 위반으로 봅니다.'),
      });
    });
  },
};

export const kosmoCd4DataType: Rule = {
  id: 'KOSMO-CD-4',
  layer: 'L3',
  get title() {
    return tr('DataType 설정 검사 — 값 유무와 KOSMO 허용 목록');
  },
  get source() {
    return fill(tr('{0} (실측 3·4차 위반)'), { 0: SOURCE });
  },
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
          message: tr('IEC 61360 데이터 명세가 없습니다.'),
          remedy: tr('DataSpecificationIec61360 내용을 embeddedDataSpecifications에 추가하십시오.'),
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
          message: tr('dataType이 설정되어 있지 않습니다.'),
          remedy: tr('대응 Property의 valueType에 맞는 dataType을 지정하십시오.'),
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
          message: fill(tr('유효하지 않은 dataType 값입니다: {0}'), { 0: content.dataType }),
          remedy: tr('STRING으로 정규화하십시오. FILE·BLOB·HTML은 AASc-3a-006에서는 허용되지만 KOSMO는 더 좁게 봅니다.'),
          fixable: true,
        });
      }
    });
  },
};

export const kosmoCd5Duplicate: Rule = {
  id: 'KOSMO-CD-5',
  layer: 'L3',
  get title() {
    return tr('ConceptDescription id·idShort 중복 검사');
  },
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
          message: fill(tr('id가 같은 ConceptDescription이 {0}건 있습니다: {1}'), { 0: indices.length, 1: id }),
          remedy: tr('중복된 CD를 하나로 합치십시오.'),
          fixable: true,
        });
      }
    }

    for (const [idShort, indices] of byIdShort) {
      if (indices.length < 2) continue;

      /*
       * Important: **if all of them are external standard dictionary (IRDI) entries, this is not a defect.**
       *
       * Measured (golden file): `ManufacturerName` exists twice, as IEC CDD (`0112/2///61987#ABA565#009`) and
       * ECLASS (`0173-1#02-AAO677#004`), and **both are actually referenced** —
       * because DigitalNameplate and TechnicalData each use a different dictionary.
       * Two different dictionaries gave the same concept the same name; it is not something we built wrong.
       *
       * And **it cannot be fixed either.** Merging them would make one submodel's semanticId stop pointing to the
       * standard dictionary, and renaming would diverge from the dictionary original. IRDIs are someone else's standard,
       * not ours to touch (in SME-5 too, the fix direction for external CDs is reversed).
       *
       * Important: so **it is not raised as a warning.** A warning about something no one can act on leads people to
       *    try to fix it and fail — that is noise, not a finding (user feedback, 2026-09-01).
       *    The fact must still be recorded, so it is lowered to `info` and **explicitly says not to fix it.**
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
            ? fill(tr('같은 이름의 표준 사전 항목이 {0}곳에 있습니다: {1}'), { 0: indices.length, 1: idShort })
            : fill(tr('idShort가 같은 ConceptDescription이 {0}건 있습니다: {1}'), { 0: indices.length, 1: idShort }),
          remedy: allExternal
            ? tr('고치지 마십시오. 서로 다른 표준 사전(IEC CDD·ECLASS 등)이 같은 개념에 같은 이름을 붙인 것이고, 각각 다른 서브모델이 참조합니다. 합치면 한쪽이 표준 사전을 못 가리키게 됩니다.')
            : tr('서로 다른 개념이면 idShort를 구분하고, 같은 개념이면 하나로 합치십시오.'),
          fixable: false,
          ...(allExternal
            ? {
                policyNote: tr('외부 표준 사전(IRDI) 항목이라 우리가 손댈 대상이 아닙니다. 사실만 알리고 지적하지 않습니다.'),
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
