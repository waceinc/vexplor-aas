/**
 * L3 — KOSMO project rules · Submodel #1 – #4.
 *
 * SM#3 (semanticId whitelist) is where it directly conflicts with KTL §4 caution 1 (spec §5 conflict ①).
 * Depending on the iriConflict policy it becomes error or warning; either way the reason is recorded in policyNote.
 */
import type { Submodel } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { LintContext, Rule, Severity } from '../types.js';
import { firstKeyValue, idVersionSuffix, isAllowedId, isIdtaIri } from '../util.js';
import { idShortFits, idShortRemedyV30, mayBe } from '../version.js';

// i18n-ignore — source document file name
const SOURCE = '02_Validator_대응규칙.md §1.2 · §2③';

function eachSubmodel(
  ctx: LintContext,
  fn: (sm: Submodel, pointer: string, kosmoPath: string, key: string) => void,
): void {
  (ctx.environment.submodels ?? []).forEach((sm, i) => {
    const key = sm.idShort ?? sm.id;
    fn(sm, `/submodels/${i}`, `/submodels/${i}(${key})`, key);
  });
}

export const kosmoSm1IdShort: Rule = {
  id: 'KOSMO-SM-1',
  layer: 'L3',
  get title() {
    return tr('Submodel idShort 설정 및 명명 규칙 검사');
  },
  source: SOURCE,
  check(ctx, report) {
    eachSubmodel(ctx, (sm, pointer, kosmoPath, key) => {
      if (!sm.idShort) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: tr('Submodel에 idShort가 없습니다.'),
          remedy: tr('IDTA 표준 서브모델명(DigitalNameplate 등)을 지정하십시오.'),
          fixable: false,
        });
        return;
      }
      if (!idShortFits(ctx, sm.idShort)) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: fill(tr('idShort가 명명 규칙에 맞지 않습니다: {0}'), { 0: sm.idShort }),
          remedy: !mayBe(ctx, '3.1') ? idShortRemedyV30() : tr('영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오.'),
          fixable: true,
        });
      }
    });
  },
};

export const kosmoSm2IdFormat: Rule = {
  id: 'KOSMO-SM-2',
  layer: 'L3',
  get title() {
    return tr('Submodel Id 형식 검사 — administration의 version·revision과 Id 접미 일치');
  },
  get source() {
    return fill(tr('{0} (실측 2차 위반)'), { 0: SOURCE });
  },
  check(ctx, report) {
    eachSubmodel(ctx, (sm, pointer, kosmoPath, key) => {
      const admin = sm.administration;
      if (!admin?.version || !admin.revision) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/administration`,
          kosmoPath: `${kosmoPath}/administration`,
          message: tr('Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.'),
          remedy: tr(
            'administration에 version·revision을 입력하십시오. IDTA 템플릿 버전을 쓴다면(예: DigitalNameplate 3.0 rev1) Id도 그 값으로 끝나야 합니다.',
          ),
          fixable: true,
        });
        return;
      }
      const expected = `${admin.version}/${admin.revision}`;
      const actual = idVersionSuffix(sm.id);
      if (actual !== expected) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/id`,
          kosmoPath: `${kosmoPath}/id`,
          message: fill(tr('Id의 끝 두 세그먼트가 administration과 일치하지 않습니다: {0} (기대값 {1})'), {
            0: actual,
            1: expected,
          }),
          remedy: fill(tr('Id가 {0} 로 끝나도록 맞추십시오. /1/0 고정은 위반입니다.'), { 0: expected }),
          fixable: true,
        });
      }
    });
  },
};

export const kosmoSm3SemanticId: Rule = {
  id: 'KOSMO-SM-3',
  layer: 'L3',
  get title() {
    return tr('Submodel semanticId 설정 및 명명 규칙 검사 — IRDI 또는 자체 IRI 화이트리스트');
  },
  get source() {
    return fill(tr('{0} (실측 1·3차 위반, KTL §4 주의1과 충돌)'), { 0: SOURCE });
  },
  check(ctx, report) {
    const { policy } = ctx;
    eachSubmodel(ctx, (sm, pointer, kosmoPath, key) => {
      const value = firstKeyValue(sm.semanticId);
      if (value === undefined) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/semanticId`,
          kosmoPath: `${kosmoPath}/semanticId`,
          message: tr('semanticId가 없습니다.'),
          remedy: tr('자신의 Submodel Id를 semanticId로 지정하십시오.'),
          fixable: true,
        });
        return;
      }

      if (isAllowedId(value, policy)) {
        // Passes the whitelist. But if the key type is not GlobalReference, basyx drops the submodel
        const keyType = sm.semanticId?.keys?.[0]?.type;
        if (sm.semanticId?.type === 'ExternalReference' && keyType !== 'GlobalReference') {
          report({
            severity: 'error',
            elementType: 'Submodel',
            key,
            pointer: `${pointer}/semanticId/keys/0/type`,
            kosmoPath: `${kosmoPath}/semanticId`,
            message: fill(tr('ExternalReference의 키 타입이 GlobalReference가 아닙니다: {0}'), { 0: keyType ?? tr('없음') }),
            remedy: tr(
              'GlobalReference로 되돌리십시오. Submodel로 바꾸면 AASd-122/124 위반이 되고 basyx가 해당 서브모델을 예외 없이 통째로 버립니다(실측 7→5).',
            ),
            fixable: true,
          });
        }
        return;
      }

      const idta = isIdtaIri(value);
      const severity: Severity =
        idta && policy.iriConflict === 'idta-preserve' ? 'warning' : 'error';

      report({
        severity,
        elementType: 'Submodel',
        key,
        pointer: `${pointer}/semanticId`,
        kosmoPath: `${kosmoPath}/semanticId`,
        message: fill(tr('semanticId가 허용 목록 밖입니다: {0}'), { 0: value }),
        remedy: fill(tr('IRDI({0}) 또는 {1}/... 형식으로 바꾸십시오.'), {
          0: policy.irdiPrefixes.join(' / '),
          1: policy.iriBase,
        }),
        fixable: true,
        ...(idta
          ? {
              policyNote:
                policy.iriConflict === 'idta-preserve'
                  ? tr('IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다. KOSMO Validator는 이를 거부합니다.')
                  : tr('IDTA 공식 IRI이지만 정책(kosmo-first)에 따라 위반으로 봅니다. 교정 시 이관 대장에 원본 IRI를 기록하십시오.'),
            }
          : {}),
      });
    });
  },
};

export const kosmoSm4TemplateKind: Rule = {
  id: 'KOSMO-SM-4',
  layer: 'L3',
  get title() {
    return tr('Kind 유형 검사 — Submodel.kind는 Template이어야 한다');
  },
  source: SOURCE,
  check(ctx, report) {
    eachSubmodel(ctx, (sm, pointer, kosmoPath, key) => {
      if (sm.kind !== 'Template') {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/kind`,
          kosmoPath: `${kosmoPath}/kind`,
          message: fill(tr('kind가 Template이 아닙니다: {0}'), { 0: sm.kind ?? tr('없음') }),
          remedy: tr('kind를 Template으로 지정하십시오.'),
          fixable: true,
        });
      }
    });
  },
};

/**
 * Two Submodels with the same idShort in one file.
 *
 * The spec does not forbid it (Submodel is Identifiable, distinguished by id) — so KOSMO does not check it either.
 * But a real file appeared where "Import" created two DigitalNameplates of different versions (2026-09-03),
 * and documentation data, Package Explorer, and collection mapping all look up submodels **by name**. Nobody
 * decides which one is the submission, so a person must delete one — reported as a warning.
 */
export const smDuplicateIdShort: Rule = {
  id: 'SM-DUP-IDSHORT',
  layer: 'L3',
  get title() {
    return tr('한 파일 안에 같은 이름(idShort)의 Submodel이 둘 이상');
  },
  get source() {
    return tr('가져오기 실측 2026-09-03 · 문서 자료·수집 매핑이 이름으로 찾는다');
  },
  check(ctx, report) {
    const seen = new Map<string, number>();
    eachSubmodel(ctx, (sm) => {
      if (sm.idShort) seen.set(sm.idShort, (seen.get(sm.idShort) ?? 0) + 1);
    });
    eachSubmodel(ctx, (sm, pointer, kosmoPath, key) => {
      if (!sm.idShort || (seen.get(sm.idShort) ?? 0) < 2) return;
      report({
        severity: 'warning',
        elementType: 'Submodel',
        key,
        pointer: `${pointer}/idShort`,
        kosmoPath: `${kosmoPath}/idShort`,
        message: fill(tr('같은 이름의 Submodel이 {0}개입니다: {1}'), { 0: seen.get(sm.idShort), 1: sm.idShort }),
        remedy: tr('하나만 남기고 지우거나, 둘 다 필요하면 이름을 다르게 하십시오. 문서 자료와 수집 매핑은 이름으로 찾습니다.'),
        fixable: false,
      });
    });
  },
};

export const KOSMO_SM_RULES: readonly Rule[] = [
  kosmoSm1IdShort,
  kosmoSm2IdFormat,
  kosmoSm3SemanticId,
  kosmoSm4TemplateKind,
  smDuplicateIdShort,
];
