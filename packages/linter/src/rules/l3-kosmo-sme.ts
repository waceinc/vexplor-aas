/**
 * L3 — KOSMO project rules · SME #1 to #5.
 *
 * SME#3 (ConceptDescription mapping) is the most frequent measured defect.
 * A narrow scope cut it from 122 to 56, but it recurred because intermediate SMCs were missed (15 in file 01, 11 in file 03).
 * So the scope is set wide: every element that can carry a semanticId (spec §1 pitfall).
 */
import type { Property } from '@aas/core';
import { fill, tr } from '@aas/core';
import type { Rule } from '../types.js';
import { isStandardTerm } from '../policy.js';
import {
  firstKeyValue,
  iec61360Of,
  SEMANTIC_REQUIRED_TYPES,
  XS_TO_DATA_TYPE,
} from '../util.js';
import { idShortFits, idShortRemedyV30, mayBe } from '../version.js';

// i18n-ignore — source document file name
const SOURCE = '02_Validator_대응규칙.md §2④⑤ · 04_린터_규칙_명세.md §1';

/** KOSMO SME#2 — special elements this project's deliverables decided not to use */
const EXCLUDED_ELEMENT_TYPES = new Set(['Operation', 'BasicEventElement', 'Capability']);

export const kosmoSme1IdShort: Rule = {
  id: 'KOSMO-SME-1',
  layer: 'L3',
  get title() {
    return tr('SubmodelElement idShort 설정 및 명명 규칙 검사');
  },
  source: SOURCE,
  check(ctx, report) {
    for (const v of ctx.elements) {
      const isListChild = v.parent?.modelType === 'SubmodelElementList';
      const idShort = v.node.idShort;

      // AASd-117: direct children of an SML may lack idShort. When they have one, the naming rule still applies —
      // KOSMO modelling guideline V2.1.1 rule 3 (metamodel 3.1 removed AASd-120; 3.0's AASd-120 is checked in L2)
      if (idShort === undefined || idShort === '') {
        if (isListChild) continue;
        report({
          severity: 'error',
          elementType: v.node.modelType,
          key: v.idShortPath,
          pointer: `${v.pointer}/idShort`,
          kosmoPath: `${v.kosmoPath}/idShort`,
          message: tr('idShort가 없습니다.'),
          remedy: tr('SubmodelElementList의 직계 자식을 제외한 모든 요소에는 idShort가 필요합니다(AASd-117).'),
          fixable: false,
        });
        continue;
      }

      if (!idShortFits(ctx, idShort)) {
        report({
          severity: 'error',
          elementType: v.node.modelType,
          key: idShort,
          pointer: `${v.pointer}/idShort`,
          kosmoPath: `${v.kosmoPath}/idShort`,
          message: fill(tr('idShort가 명명 규칙에 맞지 않습니다: {0}'), { 0: idShort }),
          remedy: !mayBe(ctx, '3.1') ? idShortRemedyV30() : tr('영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오. 한글·공백·특수문자는 쓸 수 없습니다.'),
          fixable: true,
        });
      }
    }
  },
};

export const kosmoSme2ExcludedTypes: Rule = {
  id: 'KOSMO-SME-2',
  layer: 'L3',
  get title() {
    return tr('특수 SME 배제 여부 검사 — Operation · BasicEventElement · Capability');
  },
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
        message: fill(tr('본 사업에서 사용하지 않는 요소 종류입니다: {0}'), { 0: v.node.modelType }),
        remedy: tr('Property·SubmodelElementCollection 등 표현 가능한 요소로 대체하십시오.'),
        fixable: false,
      });
    }
  },
};

export const kosmoSme3ConceptMapping: Rule = {
  id: 'KOSMO-SME-3',
  layer: 'L3',
  get title() {
    return tr('ConceptDescription 매핑 검사 — semanticId 유무와 같은 id의 CD 유무');
  },
  get source() {
    return fill(tr('{0} (실측 최다 결함, 3·4차 위반)'), { 0: SOURCE });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      const { node } = v;
      if (!SEMANTIC_REQUIRED_TYPES.has(node.modelType)) continue;

      const value = firstKeyValue(node.semanticId);

      if (value === undefined) {
        // Direct (anonymous) children of an SML follow the parent's semanticIdListElement, so they are excluded
        const isListChild = v.parent?.modelType === 'SubmodelElementList';
        if (isListChild && !node.idShort) continue;

        report({
          severity: 'error',
          elementType: node.modelType,
          key: node.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/semanticId`,
          kosmoPath: v.kosmoPath,
          message: tr('semanticId가 없습니다.'),
          remedy: fill(
            tr('해당 {0}의 semanticId를 {1}/cd/{idShort}/1/0 형식으로 지정하고 같은 id의 ConceptDescription을 함께 생성하십시오.'),
            { 0: node.modelType, 1: ctx.policy.iriBase },
          ),
          fixable: true,
        });
        continue;
      }

      if (!ctx.index.conceptDescriptions.has(value)) {
        // Terms from standard templates (W3C WoT · IDTA) are not ours to create CDs for —
        // because the official templates do not provide CDs (IDTA-02017 measured: 0 CDs).
        // Under policy preserve, they are kept only as notes (KTL §7: standard templates stay as the original).
        const standard =
          ctx.policy.standardTemplateSemantics === 'preserve' && isStandardTerm(value);
        report({
          severity: standard ? 'info' : 'error',
          elementType: node.modelType,
          key: node.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/semanticId`,
          kosmoPath: v.kosmoPath,
          message: fill(tr('semanticId에 대응하는 ConceptDescription이 없습니다: {0}'), { 0: value }),
          remedy: standard
            ? tr('표준 템플릿의 용어입니다. 그대로 두십시오 — 자체 CD로 바꾸면 템플릿의 의미가 깨집니다.')
            : tr('그 id의 ConceptDescription을 생성하거나, 기존 CD의 id를 가리키도록 고치십시오.'),
          fixable: !standard,
          ...(standard
            ? {
                policyNote: tr(
                  '정책(preserve) — IDTA·W3C 표준 용어라 교정 대상에서 뺐습니다. KOSMO Validator가 이를 어떻게 판정하는지는 실측 자료가 없으니 Validator로 확인하십시오.',
                ),
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
  get title() {
    return tr('Property value 값 존재 검사 (DigitalNameplate·HandoverDocumentation 제외)');
  },
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
          message: tr('Property에 값이 없습니다.'),
          remedy: tr('예시 데이터를 입력하십시오. 값이 비면 Validator가 위반으로 판정합니다.'),
          fixable: false,
        });
      }
    }
  },
};

export const kosmoSme5ValueTypeMatch: Rule = {
  id: 'KOSMO-SME-5',
  layer: 'L3',
  get title() {
    return tr('Property valueType과 ConceptDescription dataType 정합 검사');
  },
  get source() {
    return fill(tr('{0} (실측 3차 위반)'), { 0: SOURCE });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'Property') continue;
      const prop = v.node as Property;

      const semantic = firstKeyValue(prop.semanticId);
      if (semantic === undefined) continue; // SME#3 already reports this

      const cd = ctx.index.conceptDescriptions.get(semantic);
      if (!cd) continue; // SME#3 already reports this

      const dataType = iec61360Of(cd)?.dataType;
      const allowed = XS_TO_DATA_TYPE[prop.valueType];
      if (!allowed) continue; // valueTypes not in the mapping table are not checked

      if (dataType === undefined || !allowed.includes(dataType)) {
        const external = ctx.policy.irdiPrefixes.some((p) => semantic.startsWith(p));
        report({
          severity: 'error',
          elementType: 'Property',
          key: prop.idShort ?? v.idShortPath,
          pointer: `${v.pointer}/valueType`,
          kosmoPath: v.kosmoPath,
          message: fill(tr('valueType과 CD의 dataType이 맞지 않습니다: {0} 대 {1}'), {
            0: prop.valueType,
            1: dataType ?? tr('없음'),
          }),
          remedy: external
            ? fill(tr('외부 표준 사전 CD이므로 원본을 두고 Property의 valueType을 {0}에 맞는 값으로 바꾸십시오.'), {
                0: allowed.join(tr(' 또는 ')),
              })
            : fill(tr('자체 CD이므로 CD의 dataType을 {0} 중 하나로 바꾸십시오.'), { 0: allowed.join(tr(' 또는 ')) }),
          fixable: true,
          policyNote: external
            ? tr('외부 CD(IRDI)는 교정 방향이 반대입니다 — 우리 쪽 valueType을 맞춥니다.')
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
