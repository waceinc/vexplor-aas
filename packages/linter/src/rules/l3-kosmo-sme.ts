/**
 * L3 — KOSMO 사업 규칙 · SME #1 ~ #5.
 *
 * SME#3(ConceptDescription 매핑)은 실측 최다 결함이다.
 * 좁게 잡아 122건 → 56건으로 줄었다가 중간 계층 SMC 누락으로 재발했다(01번 15건, 03번 11건).
 * 그래서 대상 범위를 semanticId를 가질 수 있는 모든 요소로 넓게 잡는다(명세 §1 함정).
 */
import type { Property } from '@aas/core';
import type { Rule } from '../types.js';
import { isStandardTerm } from '../policy.js';
import {
  firstKeyValue,
  iec61360Of,
  isValidIdShort,
  SEMANTIC_REQUIRED_TYPES,
  XS_TO_DATA_TYPE,
} from '../util.js';

const SOURCE = '02_Validator_대응규칙.md §2④⑤ · 04_린터_규칙_명세.md §1';

/** KOSMO SME#2 — 본 사업 산출물에서 쓰지 않기로 한 특수 요소 */
const EXCLUDED_ELEMENT_TYPES = new Set(['Operation', 'BasicEventElement', 'Capability']);

export const kosmoSme1IdShort: Rule = {
  id: 'KOSMO-SME-1',
  layer: 'L3',
  title: 'SubmodelElement idShort 설정 및 명명 규칙 검사',
  source: SOURCE,
  check(ctx, report) {
    for (const v of ctx.elements) {
      const isListChild = v.parent?.modelType === 'SubmodelElementList';
      const idShort = v.node.idShort;

      // AASd-117: SML 직계 자식은 idShort가 없어도 된다 (AASd-120은 V3에서 삭제됨)
      if (idShort === undefined || idShort === '') {
        if (isListChild) continue;
        report({
          severity: 'error',
          elementType: v.node.modelType,
          key: v.idShortPath,
          pointer: `${v.pointer}/idShort`,
          kosmoPath: `${v.kosmoPath}/idShort`,
          message: 'idShort가 없습니다.',
          remedy: 'SubmodelElementList의 직계 자식을 제외한 모든 요소에는 idShort가 필요합니다(AASd-117).',
          fixable: false,
        });
        continue;
      }

      if (!isValidIdShort(idShort)) {
        report({
          severity: 'error',
          elementType: v.node.modelType,
          key: idShort,
          pointer: `${v.pointer}/idShort`,
          kosmoPath: `${v.kosmoPath}/idShort`,
          message: `idShort가 명명 규칙에 맞지 않습니다: ${idShort}`,
          remedy: '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오. 한글·공백·특수문자는 쓸 수 없습니다.',
          fixable: true,
        });
      }
    }
  },
};

export const kosmoSme2ExcludedTypes: Rule = {
  id: 'KOSMO-SME-2',
  layer: 'L3',
  title: '특수 SME 배제 여부 검사 — Operation · BasicEventElement · Capability',
  source: SOURCE,
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (!EXCLUDED_ELEMENT_TYPES.has(v.node.modelType)) continue;
      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: v.pointer,
        kosmoPath: v.kosmoPath,
        message: `본 사업에서 사용하지 않는 요소 종류입니다: ${v.node.modelType}`,
        remedy: 'Property·SubmodelElementCollection 등 표현 가능한 요소로 대체하십시오.',
        fixable: false,
      });
    }
  },
};

export const kosmoSme3ConceptMapping: Rule = {
  id: 'KOSMO-SME-3',
  layer: 'L3',
  title: 'ConceptDescription 매핑 검사 — semanticId 존재 및 동일 id의 CD 존재',
  source: `${SOURCE} (실측 최다 결함, 3·4차 위반)`,
  check(ctx, report) {
    for (const v of ctx.elements) {
      const { node } = v;
      if (!SEMANTIC_REQUIRED_TYPES.has(node.modelType)) continue;

      const value = firstKeyValue(node.semanticId);

      if (value === undefined) {
        // SML 직계 자식(익명)은 부모의 semanticIdListElement를 따르므로 대상에서 제외한다
        const isListChild = v.parent?.modelType === 'SubmodelElementList';
        if (isListChild && !node.idShort) continue;

        report({
          severity: 'error',
          elementType: node.modelType,
          key: node.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/semanticId`,
          kosmoPath: v.kosmoPath,
          message: 'semanticId가 없습니다.',
          remedy:
            `해당 ${node.modelType}의 semanticId를 ${ctx.policy.iriBase}/cd/{idShort}/1/0 형식으로 지정하고 ` +
            '같은 id의 ConceptDescription을 함께 생성하십시오.',
          fixable: true,
        });
        continue;
      }

      if (!ctx.index.conceptDescriptions.has(value)) {
        // 표준 템플릿의 용어(W3C WoT·IDTA)는 우리가 CD를 만들 대상이 아니다 —
        // 공식 템플릿이 CD를 제공하지 않기 때문이다(IDTA-02017 실측: CD 0개).
        // 정책 preserve면 참고로만 남긴다(KTL §7: 표준 템플릿은 원본 그대로).
        const standard =
          ctx.policy.standardTemplateSemantics === 'preserve' && isStandardTerm(value);
        report({
          severity: standard ? 'info' : 'error',
          elementType: node.modelType,
          key: node.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/semanticId`,
          kosmoPath: v.kosmoPath,
          message: `semanticId에 대응하는 ConceptDescription이 없습니다: ${value}`,
          remedy: standard
            ? '표준 템플릿의 용어입니다. 그대로 두십시오 — 자체 CD로 바꾸면 템플릿의 의미가 깨집니다.'
            : '해당 id를 가진 ConceptDescription을 생성하거나, 기존 CD의 id를 가리키도록 고치십시오.',
          fixable: !standard,
          ...(standard
            ? {
                policyNote:
                  '정책(preserve) — IDTA·W3C 표준 용어라 교정 대상에서 뺐습니다. ' +
                  'KOSMO Validator가 이를 어떻게 판정하는지는 실측 자료가 없으니 제출 전에 확인하십시오.',
              }
            : {}),
        });
      }
    }
  },
};

export const kosmoSme4PropertyValue: Rule = {
  id: 'KOSMO-SME-4',
  layer: 'L3',
  title: 'Property value 값 존재 검사 (DigitalNameplate·HandoverDocumentation 제외)',
  source: SOURCE,
  check(ctx, report) {
    const exempt = new Set(ctx.policy.valueCheckExemptSubmodels);
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'Property') continue;
      if (exempt.has(v.submodel.idShort ?? '')) continue;

      const prop = v.node as Property;
      if (prop.value === undefined || prop.value.trim() === '') {
        report({
          severity: 'error',
          elementType: 'Property',
          key: prop.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/value`,
          kosmoPath: v.kosmoPath,
          message: 'Property에 값이 없습니다.',
          remedy: '예시 데이터를 입력하십시오. 값이 비면 Validator가 위반으로 판정합니다.',
          fixable: false,
        });
      }
    }
  },
};

export const kosmoSme5ValueTypeMatch: Rule = {
  id: 'KOSMO-SME-5',
  layer: 'L3',
  title: 'Property valueType과 ConceptDescription dataType 정합 검사',
  source: `${SOURCE} (실측 3차 위반)`,
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'Property') continue;
      const prop = v.node as Property;

      const semantic = firstKeyValue(prop.semanticId);
      if (semantic === undefined) continue; // SME#3이 이미 보고한다

      const cd = ctx.index.conceptDescriptions.get(semantic);
      if (!cd) continue; // SME#3이 이미 보고한다

      const dataType = iec61360Of(cd)?.dataType;
      const allowed = XS_TO_DATA_TYPE[prop.valueType];
      if (!allowed) continue; // 매핑표에 없는 valueType은 검사 대상이 아니다

      if (dataType === undefined || !allowed.includes(dataType)) {
        const external = ctx.policy.irdiPrefixes.some((p) => semantic.startsWith(p));
        report({
          severity: 'error',
          elementType: 'Property',
          key: prop.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/valueType`,
          kosmoPath: v.kosmoPath,
          message: `valueType과 CD의 dataType이 맞지 않습니다: ${prop.valueType} 대 ${dataType ?? '없음'}`,
          remedy: external
            ? `외부 표준 사전 CD이므로 원본을 두고 Property의 valueType을 ${allowed.join(' 또는 ')}에 맞는 값으로 바꾸십시오.`
            : `자체 CD이므로 CD의 dataType을 ${allowed.join(' 또는 ')} 중 하나로 바꾸십시오.`,
          fixable: true,
          policyNote: external
            ? '외부 CD(IRDI)는 교정 방향이 반대입니다 — 우리 쪽 valueType을 맞춥니다.'
            : undefined,
        });
      }
    }
  },
};

export const KOSMO_SME_RULES: readonly Rule[] = [
  kosmoSme1IdShort,
  kosmoSme2ExcludedTypes,
  kosmoSme3ConceptMapping,
  kosmoSme4PropertyValue,
  kosmoSme5ValueTypeMatch,
];
