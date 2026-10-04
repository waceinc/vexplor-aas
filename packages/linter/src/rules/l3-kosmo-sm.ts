/**
 * L3 — KOSMO 사업 규칙 · Submodel #1 ~ #4.
 *
 * SM#3(semanticId 화이트리스트)은 KTL §4 주의1과 정면 충돌하는 지점이다(명세 §5 충돌 ①).
 * 정책 iriConflict에 따라 error / warning이 갈리며, 어느 쪽이든 policyNote로 사유를 남긴다.
 */
import type { Submodel } from '@aas/core';
import type { LintContext, Rule, Severity } from '../types.js';
import { firstKeyValue, idVersionSuffix, isAllowedId, isIdtaIri, isValidIdShort } from '../util.js';

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
  title: 'Submodel idShort 설정 및 명명 규칙 검사',
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
          message: 'Submodel에 idShort가 없습니다.',
          remedy: 'IDTA 표준 서브모델명(DigitalNameplate 등)을 지정하십시오.',
          fixable: false,
        });
        return;
      }
      if (!isValidIdShort(sm.idShort)) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/idShort`,
          kosmoPath: `${kosmoPath}/idShort`,
          message: `idShort가 명명 규칙에 맞지 않습니다: ${sm.idShort}`,
          remedy: '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오.',
          fixable: true,
        });
      }
    });
  },
};

export const kosmoSm2IdFormat: Rule = {
  id: 'KOSMO-SM-2',
  layer: 'L3',
  title: 'Submodel Id 형식 검사 — administration의 version·revision과 Id 접미 일치',
  source: `${SOURCE} (실측 2차 위반)`,
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
          message: 'Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.',
          remedy:
            'administration에 version·revision을 입력하십시오. ' +
            'IDTA 템플릿 버전을 쓴다면(예: DigitalNameplate 3.0 rev1) Id도 그 값으로 끝나야 합니다.',
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
          message: `Id의 끝 두 세그먼트가 administration과 일치하지 않습니다: ${actual} (기대값 ${expected})`,
          remedy: `Id가 ${expected} 로 끝나도록 맞추십시오. /1/0 고정은 위반입니다.`,
          fixable: true,
        });
      }
    });
  },
};

export const kosmoSm3SemanticId: Rule = {
  id: 'KOSMO-SM-3',
  layer: 'L3',
  title: 'Submodel semanticId 설정 및 명명 규칙 검사 — IRDI 또는 자체 IRI 화이트리스트',
  source: `${SOURCE} (실측 1·3차 위반, KTL §4 주의1과 충돌)`,
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
          message: 'semanticId가 없습니다.',
          remedy: '자신의 Submodel Id를 semanticId로 지정하십시오.',
          fixable: true,
        });
        return;
      }

      if (isAllowedId(value, policy)) {
        // 화이트리스트 통과. 다만 key type이 GlobalReference가 아니면 basyx가 서브모델을 드롭한다
        const keyType = sm.semanticId?.keys?.[0]?.type;
        if (sm.semanticId?.type === 'ExternalReference' && keyType !== 'GlobalReference') {
          report({
            severity: 'error',
            elementType: 'Submodel',
            key,
            pointer: `${pointer}/semanticId/keys/0/type`,
            kosmoPath: `${kosmoPath}/semanticId`,
            message: `ExternalReference의 키 타입이 GlobalReference가 아닙니다: ${keyType ?? '없음'}`,
            remedy:
              'GlobalReference로 되돌리십시오. Submodel로 바꾸면 AASd-122/124 위반이 되고 ' +
              'basyx가 해당 서브모델을 예외 없이 통째로 드롭합니다(실측 7→5).',
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
        message: `semanticId가 허용 목록 밖입니다: ${value}`,
        remedy: `IRDI(${policy.irdiPrefixes.join(' / ')}) 또는 ${policy.iriBase}/... 형식으로 바꾸십시오.`,
        fixable: true,
        ...(idta
          ? {
              policyNote:
                policy.iriConflict === 'idta-preserve'
                  ? 'IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다. KOSMO Validator는 이를 거부합니다.'
                  : 'IDTA 공식 IRI이지만 정책(kosmo-first)에 따라 위반으로 봅니다. 교정 시 이관 대장에 원본 IRI를 기록하십시오.',
            }
          : {}),
      });
    });
  },
};

export const kosmoSm4TemplateKind: Rule = {
  id: 'KOSMO-SM-4',
  layer: 'L3',
  title: 'Kind 유형 검사 — Submodel.kind는 Template이어야 한다',
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
          message: `kind가 Template이 아닙니다: ${sm.kind ?? '없음'}`,
          remedy: 'kind를 Template으로 지정하십시오.',
          fixable: true,
        });
      }
    });
  },
};

/**
 * 한 파일 안에 같은 idShort의 Submodel이 둘.
 *
 * 규격은 막지 않는다(Submodel은 Identifiable이라 id로 구별한다) — 그래서 KOSMO도 안 본다.
 * 그러나 「가져오기」로 판이 다른 DigitalNameplate가 둘 생긴 파일이 실제로 나왔고(2026-09-03),
 * 문서용 자료·Package Explorer·수집 매핑 모두 **이름으로** 서브모델을 찾는다. 어느 것이
 * 제출물인지 아무도 정해 주지 않으니 사람이 하나를 지워야 한다 — 경고로 알린다.
 */
export const smDuplicateIdShort: Rule = {
  id: 'SM-DUP-IDSHORT',
  layer: 'L3',
  title: '한 파일 안에 같은 이름(idShort)의 Submodel이 둘 이상',
  source: '가져오기 실측 2026-09-03 · 문서 자료·수집 매핑이 이름으로 찾는다',
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
        message: `같은 이름의 Submodel이 ${seen.get(sm.idShort)}개입니다: ${sm.idShort}`,
        remedy: '하나만 남기고 지우거나, 둘 다 필요하면 이름을 다르게 하십시오. 문서 자료와 수집 매핑은 이름으로 찾습니다.',
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
