/**
 * L2 — AASd / AASc-3a constraints.
 *
 * Of all 25, only the ones that are easy to get wrong when generating AASX from code are implemented.
 * The rest are structurally guaranteed by using a correct object model (spec §1 L2).
 *
 * Important: AASd-090 and AASd-120 **are implemented** (corrected 2026-08-24). This comment used to say
 *    they were "removed in V3", which is false — both exist in aas-core-meta v3. The correct statement is:
 *    **the KOSMO Validator simply does not check them.** Standard tools enforce them (aas-test-engines reports
 *    9 errors; basyx-python-sdk silently loses the SML subtree). Full history in docs/PROGRESS.md §4.
 *
 * Items that overlap with KOSMO rules are not reported again here:
 *   AASd-002/117 → KOSMO-*-1 (idShort), AASd-131 → KOSMO-AAS-5,
 *   AASc-3a-004 → KOSMO-CD-4, AASc-3a-008 → KOSMO-CD-3
 */
import type { Entity, Property, Reference, SubmodelElementList } from '@aas/core';
import { fill, GLOBALLY_IDENTIFIABLE, tr } from '@aas/core';

/** AASd-123 — what is allowed as the first key of a model reference */
const AAS_IDENTIFIABLES = ['AssetAdministrationShell', 'Submodel', 'ConceptDescription'];
import type { LintContext, Report, Rule } from '../types.js';
import { firstKeyValue, hasLanguage, iec61360Of, needsUnit } from '../util.js';

// i18n-ignore — source document file name
const SPEC = 'AAS 참조모델 제약조건 spec_260812.pdf';

export const aasd005Administration: Rule = {
  id: 'AASd-005',
  layer: 'L2',
  get title() {
    return tr('version 없이 revision을 지정할 수 없다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    const check = (
      admin: { version?: string; revision?: string } | undefined,
      elementType: string,
      key: string,
      pointer: string,
      kosmoPath: string,
    ): void => {
      if (!admin?.revision || admin.version) return;
      report({
        severity: 'error',
        elementType,
        key,
        pointer: `${pointer}/administration`,
        kosmoPath: `${kosmoPath}/administration`,
        message: tr('version 없이 revision만 지정되어 있습니다.'),
        remedy: tr('administration에 version을 함께 입력하십시오.'),
        fixable: false,
      });
    };

    (ctx.environment.assetAdministrationShells ?? []).forEach((s, i) =>
      check(s.administration, 'AssetAdministrationShell', s.idShort ?? s.id,
        `/assetAdministrationShells/${i}`, `/assetAdministrationShells/${i}(${s.idShort ?? s.id})`),
    );
    (ctx.environment.submodels ?? []).forEach((s, i) =>
      check(s.administration, 'Submodel', s.idShort ?? s.id,
        `/submodels/${i}`, `/submodels/${i}(${s.idShort ?? s.id})`),
    );
    (ctx.environment.conceptDescriptions ?? []).forEach((c, i) =>
      check(c.administration, 'ConceptDescription', c.idShort ?? c.id,
        `/conceptDescriptions/${i}`, `/conceptDescriptions/${i}(${c.idShort ?? c.id})`),
    );
  },
};

export const aasd014Entity: Rule = {
  id: 'AASd-014',
  layer: 'L2',
  get title() {
    return tr('SelfManagedEntity는 globalAssetId 또는 specificAssetId를 가져야 한다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'Entity') continue;
      const entity = v.node as Entity;
      if (entity.entityType !== 'SelfManagedEntity') continue;
      if (entity.globalAssetId || (entity.specificAssetIds?.length ?? 0) > 0) continue;

      report({
        severity: 'error',
        elementType: 'Entity',
        key: entity.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/globalAssetId`,
        kosmoPath: v.kosmoPath,
        message: tr('SelfManagedEntity에 globalAssetId도 specificAssetIds도 없습니다.'),
        remedy: tr('자산 식별자를 지정하거나 entityType을 CoManagedEntity로 바꾸십시오.'),
        fixable: false,
      });
    }
  },
};

export const aasd022UniqueIdShort: Rule = {
  id: 'AASd-022',
  layer: 'L2',
  get title() {
    return tr('같은 네임스페이스 안에서 idShort는 고유해야 한다 (대소문자 구분)');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    // Namespace = parent container. Group by the parent pointer as the key
    const groups = new Map<string, Map<string, number>>();

    for (const v of ctx.elements) {
      // Direct SML children are identified by position, so uniqueness does not apply to them
      if (v.parent?.modelType === 'SubmodelElementList') continue;
      const idShort = v.node.idShort;
      if (!idShort) continue;

      const parentPointer = v.pointer.slice(0, v.pointer.lastIndexOf('/'));
      const bucket = groups.get(parentPointer) ?? new Map<string, number>();
      const seen = bucket.get(idShort) ?? 0;
      if (seen > 0) {
        report({
          severity: 'error',
          elementType: v.node.modelType,
          key: idShort,
          pointer: `${v.pointer}/idShort`,
          kosmoPath: v.kosmoPath,
          message: fill(tr('같은 네임스페이스에 동일한 idShort가 이미 있습니다: {0}'), { 0: idShort }),
          remedy: tr('형제 요소끼리 이름이 겹치지 않도록 바꾸십시오. 대소문자만 다른 것도 허용되지 않습니다.'),
          fixable: false,
        });
      }
      bucket.set(idShort, seen + 1);
      groups.set(parentPointer, bucket);
    }
  },
};

/** AASd-107 / 108 / 109 / 114 — SubmodelElementList constraints */
export const aasdSubmodelElementList: Rule = {
  id: 'AASd-107/108/109/114',
  layer: 'L2',
  get title() {
    return tr('SubmodelElementList 직계 자식의 타입·semanticId·valueType 일관성');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'SubmodelElementList') continue;
      const list = v.node as SubmodelElementList;
      const children = list.value ?? [];
      if (children.length === 0) continue;

      const key = list.idShort ?? v.idShortPath;

      // AASd-108 — all children must have the same type as typeValueListElement
      children.forEach((child, i) => {
        if (child.modelType !== list.typeValueListElement) {
          report({
            severity: 'error',
            elementType: 'SubmodelElementList',
            key,
            pointer: `${v.pointer}/value/${i}`,
            kosmoPath: `${v.kosmoPath}/value/${i}`,
            message: fill(tr('자식 요소의 타입이 typeValueListElement와 다릅니다: {0} (선언값 {1})'), {
              0: child.modelType,
              1: list.typeValueListElement,
            }),
            remedy: tr('SubmodelElementList에는 한 가지 타입만 담을 수 있습니다.'),
            fixable: false,
          });
        }
      });

      // AASd-109 — when holding Property/Range, valueTypeListElement is required
      const needsValueType =
        list.typeValueListElement === 'Property' || list.typeValueListElement === 'Range';
      if (needsValueType && !list.valueTypeListElement) {
        report({
          severity: 'error',
          elementType: 'SubmodelElementList',
          key,
          pointer: `${v.pointer}/valueTypeListElement`,
          kosmoPath: v.kosmoPath,
          message: tr('Property/Range를 담는 리스트인데 valueTypeListElement가 없습니다.'),
          remedy: tr('자식들이 공통으로 쓰는 valueType을 valueTypeListElement에 지정하십시오.'),
          fixable: true,
        });
      }
      if (needsValueType && list.valueTypeListElement) {
        children.forEach((child, i) => {
          const childValueType = (child as Property).valueType;
          if (childValueType && childValueType !== list.valueTypeListElement) {
            report({
              severity: 'error',
              elementType: 'SubmodelElementList',
              key,
              pointer: `${v.pointer}/value/${i}/valueType`,
              kosmoPath: `${v.kosmoPath}/value/${i}`,
              message: fill(tr('자식의 valueType이 valueTypeListElement와 다릅니다: {0} (선언값 {1})'), {
                0: childValueType,
                1: list.valueTypeListElement,
              }),
              remedy: tr('리스트 안의 값 타입을 통일하십시오.'),
              fixable: false,
            });
          }
        });
      }

      // AASd-107 / 114 — child semanticIds must equal each other and match semanticIdListElement
      const declared = firstKeyValue(list.semanticIdListElement);
      const childSemantics = children.map((c) => firstKeyValue(c.semanticId));
      const present = childSemantics.filter((s): s is string => s !== undefined);

      if (present.length > 0) {
        const distinct = [...new Set(present)];
        if (distinct.length > 1) {
          report({
            severity: 'error',
            elementType: 'SubmodelElementList',
            key,
            pointer: `${v.pointer}/value`,
            kosmoPath: v.kosmoPath,
            message: fill(tr('직계 자식들의 semanticId가 서로 다릅니다: {0}종'), { 0: distinct.length }),
            remedy: tr('리스트 자식은 모두 같은 semanticId를 가져야 합니다(AASd-114).'),
            fixable: false,
          });
        } else if (declared !== undefined && distinct[0] !== declared) {
          report({
            severity: 'error',
            elementType: 'SubmodelElementList',
            key,
            pointer: `${v.pointer}/semanticIdListElement`,
            kosmoPath: v.kosmoPath,
            message: fill(tr('자식의 semanticId가 semanticIdListElement와 다릅니다: {0} (선언값 {1})'), {
              0: distinct[0],
              1: declared,
            }),
            // Important: not auto-fixed — only a person knows which side is right. Measured: child was "345345" (typo), declared value a standard IRDI.
            //    It was advertised as fixable with no fixer, so the button count and the popup disagreed (2026-09-11)
            remedy: tr(
              '둘 중 맞는 쪽으로 맞추십시오 — 대개 표준 사전 값(0173-/0112/로 시작)이 맞고 자식 쪽이 오타입니다. 자식 요소를 골라 semanticId 칸에서 선언값을 넣으면 됩니다(AASd-107).',
            ),
            fixable: false,
          });
        }
      }
    }
  },
};

/** AASd-121 / 122 / 124 — Reference key rules */
export const aasdReferenceKeys: Rule = {
  id: 'AASd-121~128',
  layer: 'L2',
  get title() {
    return tr('Reference 키 사슬 — 첫 키·뒤 키·Fragment 자리의 타입 제약');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    const checkRef = (
      ref: Reference | undefined,
      field: string,
      elementType: string,
      key: string,
      pointer: string,
      kosmoPath: string,
      report2: Report,
    ): void => {
      if (!ref || ref.keys.length === 0) return;
      const first = ref.keys[0];
      const last = ref.keys[ref.keys.length - 1];
      if (!first || !last) return;

      if (!GLOBALLY_IDENTIFIABLE.includes(first.type)) {
        report2({
          severity: 'error',
          elementType,
          key,
          pointer: `${pointer}/${field}/keys/0/type`,
          kosmoPath,
          message: fill(tr('Reference의 첫 키가 GloballyIdentifiable이 아닙니다: {0}'), { 0: first.type }),
          remedy: fill(tr('첫 키 타입을 {0} 중 하나로 바꾸십시오(AASd-121).'), { 0: GLOBALLY_IDENTIFIABLE.join(' / ') }),
          fixable: true,
        });
      }

      if (ref.type === 'ModelReference') {
        // AASd-123 — the first key of a model reference must be AAS, Submodel or ConceptDescription
        if (!AAS_IDENTIFIABLES.includes(first.type)) {
          report2({
            severity: 'error',
            elementType,
            key,
            pointer: `${pointer}/${field}/keys/0/type`,
            kosmoPath,
            message: fill(tr('ModelReference의 첫 키가 AAS 식별 대상이 아닙니다: {0}'), { 0: first.type }),
            remedy: fill(tr('첫 키 타입을 {0} 중 하나로 바꾸십시오(AASd-123).'), { 0: AAS_IDENTIFIABLES.join(' / ') }),
            fixable: false,
          });
        }
        // AASd-125/126 — from the second key on, keys must be element types other than Fragment kinds
        // (a FragmentReference as the last key is allowed by 126)
        ref.keys.slice(1).forEach((chainKey, offset) => {
          const index = offset + 1;
          const isLast = index === ref.keys.length - 1;
          if (chainKey.type === 'FragmentReference' && isLast) {
            // AASd-127 — the key before a FragmentReference must be File or Blob
            const previous = ref.keys[index - 1];
            if (previous && previous.type !== 'File' && previous.type !== 'Blob') {
              report2({
                severity: 'error',
                elementType,
                key,
                pointer: `${pointer}/${field}/keys/${index}/type`,
                kosmoPath,
                message: fill(tr('FragmentReference 앞 키가 File·Blob이 아닙니다: {0}'), { 0: previous.type }),
                remedy: tr('Fragment는 파일 안 위치를 가리킵니다 — 앞 키를 File 또는 Blob으로(AASd-127).'),
            fixable: false,
              });
            }
            return;
          }
          // AASd-128 — the value after a SubmodelElementList key must be an array position (integer)
          const previousKey = ref.keys[index - 1];
          if (previousKey?.type === 'SubmodelElementList' && !/^\d+$/.test(chainKey.value)) {
            report2({
              severity: 'error',
              elementType,
              key,
              pointer: `${pointer}/${field}/keys/${index}/value`,
              kosmoPath,
              message: fill(tr('SubmodelElementList 키 뒤의 값이 정수 색인이 아닙니다: {0}'), { 0: chainKey.value }),
              remedy: tr('리스트 자식은 위치로 가리킵니다 — 0부터 시작하는 숫자를 쓰십시오(AASd-128).'),
              fixable: false,
            });
          }
          if (GLOBALLY_IDENTIFIABLE.includes(chainKey.type) || chainKey.type === 'FragmentReference') {
            report2({
              severity: 'error',
              elementType,
              key,
              pointer: `${pointer}/${field}/keys/${index}/type`,
              kosmoPath,
              message: fill(tr('ModelReference의 {0}번째 키 타입이 요소류가 아닙니다: {1}'), {
                0: index + 1,
                1: chainKey.type,
              }),
              remedy: tr('둘째 키부터는 Property·SubmodelElementCollection 같은 요소 타입이어야 합니다(AASd-125).'),
            fixable: false,
            });
          }
        });
      }

      if (ref.type === 'ExternalReference') {
        if (first.type !== 'GlobalReference') {
          report2({
            severity: 'error',
            elementType,
            key,
            pointer: `${pointer}/${field}/keys/0/type`,
            kosmoPath,
            message: fill(tr('ExternalReference의 첫 키가 GlobalReference가 아닙니다: {0}'), { 0: first.type }),
            remedy: tr(
              'GlobalReference로 바꾸십시오. Submodel로 두면 AASd-122 위반이며 basyx가 해당 서브모델을 통째로 드롭합니다(실측 7→5).',
            ),
            fixable: true,
          });
        }
        if (last.type !== 'GlobalReference' && last.type !== 'FragmentReference') {
          report2({
            severity: 'error',
            elementType,
            key,
            pointer: `${pointer}/${field}/keys/${ref.keys.length - 1}/type`,
            kosmoPath,
            message: fill(tr('ExternalReference의 마지막 키가 GlobalReference가 아닙니다: {0}'), { 0: last.type }),
            remedy: tr('마지막 키 타입을 GlobalReference로 바꾸십시오(AASd-124).'),
            fixable: true,
          });
        }
      }
    };

    (ctx.environment.submodels ?? []).forEach((sm, i) => {
      const key = sm.idShort ?? sm.id;
      checkRef(sm.semanticId, 'semanticId', 'Submodel', key,
        `/submodels/${i}`, `/submodels/${i}(${key})`, report);
    });

    for (const v of ctx.elements) {
      const key = v.node.idShort ?? v.idShortPath;
      checkRef(v.node.semanticId, 'semanticId', v.node.modelType, key, v.pointer, v.kosmoPath, report);
    }
  },
};

export const aasc3a002PreferredName: Rule = {
  id: 'AASc-3a-002',
  layer: 'L2',
  get title() {
    return tr('ConceptDescription의 preferredName에 영문이 있어야 한다');
  },
  get source() {
    return fill(tr('{0} 2장'), { 0: SPEC });
  },
  check(ctx, report) {
    (ctx.environment.conceptDescriptions ?? []).forEach((cd, i) => {
      const content = iec61360Of(cd);
      if (!content) return; // Reported by KOSMO-CD-4
      if (hasLanguage(content.preferredName, 'en')) return;

      const key = cd.idShort ?? cd.id;
      report({
        severity: 'error',
        elementType: 'ConceptDescription',
        key,
        pointer: `/conceptDescriptions/${i}/embeddedDataSpecifications/0/dataSpecificationContent/preferredName`,
        kosmoPath: `/conceptDescriptions/${i}(${key})/preferredName`,
        message: tr('preferredName에 영문(en) 항목이 없습니다.'),
        remedy: tr('영문 표기를 en 태그로 추가하십시오.'),
        fixable: true,
      });
    });
  },
};

export const aasc3a009UnitRequired: Rule = {
  id: 'AASc-3a-009',
  layer: 'L2',
  get title() {
    return tr('dataType이 MEASURE/CURRENCY 계열이면 unit 또는 unitId가 필요하다');
  },
  get source() {
    return fill(tr('{0} 2장'), { 0: SPEC });
  },
  check(ctx, report) {
    (ctx.environment.conceptDescriptions ?? []).forEach((cd, i) => {
      const content = iec61360Of(cd);
      if (!content || !needsUnit(content.dataType)) return;
      if (content.unit || content.unitId) return;

      const key = cd.idShort ?? cd.id;
      report({
        severity: 'error',
        elementType: 'ConceptDescription',
        key,
        pointer: `/conceptDescriptions/${i}/embeddedDataSpecifications/0/dataSpecificationContent/unit`,
        kosmoPath: `/conceptDescriptions/${i}(${key})/unit`,
        message: fill(tr('dataType이 {0}인데 unit도 unitId도 없습니다.'), { 0: content.dataType }),
        remedy: tr(
          '단위를 지정하십시오. 무차원 값(개수·비율·역률)이라면 단위를 억지로 붙이지 말고 dataType을 REAL_COUNT / INTEGER_COUNT로 바꾸는 것이 옳습니다.',
        ),
        fixable: true,
      });
    });
  },
};

/**
 * AASd-120 — direct children of a SubmodelElementList must not have an idShort.
 *
 * Important: know the history of this rule (corrected by measurement on 2026-08-24).
 * This repository used to state "AASd-120 was removed in V3" and did not implement it. **That is false.**
 * It is still in the spec (V3.0; aas-core-meta v3 SubmodelElementList); the KOSMO Validator simply
 * does not check it. Standard tools enforce it —
 *   · `aas-test-engines` 1.0.3: fails the golden file with **9 errors**
 *   · `basyx-python-sdk`: cannot read the file at all (drops the submodel)
 * Measured: removing the 10 SML child idShorts from the golden file brings aas-test-engines to **0 errors**,
 * while KOSMO rule violations stay at 0. In other words, **removing them satisfies both sides.**
 *
 * Why the default severity is warning: there is no reason to block a KOSMO submission (it is not checked),
 * but the fact that interoperability breaks must be reported. Policy can promote or demote it.
 */
export const aasd120SmlChildIdShort: Rule = {
  id: 'AASd-120',
  layer: 'L2',
  get title() {
    return tr('SubmodelElementList 직계 자식은 idShort를 가질 수 없다');
  },
  get source() {
    return tr('AAS V3.0 메타모델 AASd-120 (aas-core-meta v3) · aas-test-engines 1.0.3 실측');
  },
  check(ctx, report) {
    const policy = ctx.policy.smlChildIdShort;
    if (policy === 'allow') return;

    for (const v of ctx.elements) {
      if (v.parent?.modelType !== 'SubmodelElementList') continue;
      const idShort = v.node.idShort;
      if (idShort === undefined || idShort === '') continue;

      report({
        severity: policy === 'forbid' ? 'error' : 'warning',
        elementType: v.node.modelType,
        key: idShort,
        pointer: `${v.pointer}/idShort`,
        kosmoPath: `${v.kosmoPath}/idShort`,
        message: fill(tr('SubmodelElementList의 직계 자식에 idShort가 있습니다: {0}'), { 0: idShort }),
        // Important: fixing a file that already passed the Validator changes its hash — bundles compare against the original bytes (2026-09-30)
        remedy: tr(
          'idShort를 지우십시오. 리스트 자식은 인덱스로 가리킵니다(AASd-120). 지워도 KOSMO 규칙에는 영향이 없고, BaSyx 적재와 표준 검증기 통과가 열립니다. 단, 이미 Validator를 받은 파일은 고치면 파일이 달라지므로 다음 판에서 고치고 Validator를 다시 받으십시오.',
        ),
        fixable: true,
        policyNote:
          policy === 'forbid'
            ? tr('정책(forbid) — 표준 준수·상호운용을 우선합니다.')
            : tr(
                'KOSMO Validator는 이 제약을 검사하지 않지만, aas-test-engines는 오류로, basyx-python-sdk는 읽기 실패로 처리합니다. 정책(warn)에 따라 경고로 표시했습니다.',
              ),
      });
    }
  },
};

/**
 * AASd-090 — a DataElement's category must be one of CONSTANT · PARAMETER · VARIABLE.
 *
 * This too was listed as "removed in V3", but **it is in the spec** (aas-core-meta v3 DataElement).
 * The statement that *leaving it empty is fine* is correct, though — the constraint only applies when a value is set.
 * The 20 equipment types do not use category, so it never surfaced; since the authoring UI began allowing
 * category to be entered, a person can enter it wrongly, so we check it.
 */
const DATA_ELEMENT_TYPES = new Set([
  'Property',
  'MultiLanguageProperty',
  'Range',
  'Blob',
  'File',
  'ReferenceElement',
]);
const ALLOWED_CATEGORIES = ['CONSTANT', 'PARAMETER', 'VARIABLE'];

export const aasd090DataElementCategory: Rule = {
  id: 'AASd-090',
  layer: 'L2',
  get title() {
    return tr('DataElement의 category는 CONSTANT · PARAMETER · VARIABLE 중 하나여야 한다');
  },
  get source() {
    return tr('AAS V3.0 메타모델 AASd-090 (aas-core-meta v3)');
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (!DATA_ELEMENT_TYPES.has(v.node.modelType)) continue;
      const category = v.node.category;
      // Leaving it empty is fine per the spec
      if (category === undefined || category === '') continue;
      if (ALLOWED_CATEGORIES.includes(category)) continue;

      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/category`,
        kosmoPath: `${v.kosmoPath}/category`,
        message: fill(tr('DataElement의 category가 허용값이 아닙니다: {0}'), { 0: category }),
        remedy: fill(tr('{0} 중 하나로 바꾸거나 비워 두십시오(AASd-090).'), { 0: ALLOWED_CATEGORIES.join(' · ') }),
        fixable: true,
      });
    }
  },
};

/**
 * AASd-118 — if supplementalSemanticIds is present, semanticId must also be present.
 *
 * Our output can actually hit this: the golden file uses supplementalSemanticIds
 * (preserving the original IDTA IRI), and clearing semanticId in the UI breaks this constraint.
 */
export const aasd118SupplementalSemantics: Rule = {
  id: 'AASd-118',
  layer: 'L2',
  get title() {
    return tr('supplementalSemanticIds가 있으면 semanticId도 있어야 한다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      const raw = v.node as unknown as Record<string, unknown>;
      const supplemental = raw['supplementalSemanticIds'];
      if (!Array.isArray(supplemental) || supplemental.length === 0) continue;
      const main = raw['semanticId'] as { keys?: unknown[] } | undefined;
      if (main && (main.keys?.length ?? 0) > 0) continue;
      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/supplementalSemanticIds`,
        kosmoPath: v.kosmoPath,
        message: tr('보조 semanticId만 있고 주 semanticId가 없습니다.'),
        remedy: tr('semanticId를 채우거나 supplementalSemanticIds를 지우십시오(AASd-118).'),
        fixable: false,
      });
    }
  },
};

/**
 * AASd-116·133 — reserved names of SpecificAssetId and the externalSubjectId type.
 * Our tool never builds this structure, but it must be filtered **when opening other people's files** (since XML open support).
 */
export const aasdSpecificAssetId: Rule = {
  id: 'AASd-116/133',
  layer: 'L2',
  get title() {
    return tr('SpecificAssetId — 예약 이름 globalAssetId 금지, externalSubjectId는 ExternalReference');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    (ctx.environment.assetAdministrationShells ?? []).forEach((shell, index) => {
      const asset = (shell as unknown as Record<string, unknown>)['assetInformation'] as
        | { specificAssetIds?: { name?: string; externalSubjectId?: { type?: string } }[] }
        | undefined;
      (asset?.specificAssetIds ?? []).forEach((entry, j) => {
        const base = `/assetAdministrationShells/${index}/assetInformation/specificAssetIds/${j}`;
        const kosmo = `/assetAdministrationShells/${index}(${shell.idShort ?? shell.id})`;
        if ((entry.name ?? '').toLowerCase() === 'globalassetid') {
          report({
            severity: 'error',
            elementType: 'AssetInformation',
            key: shell.idShort ?? shell.id,
            pointer: `${base}/name`,
            kosmoPath: kosmo,
            message: tr('specificAssetId의 이름으로 예약어 globalAssetId를 쓸 수 없습니다.'),
            remedy: tr('그 값은 assetInformation.globalAssetId 필드에 두십시오(AASd-116).'),
            fixable: false,
          });
        }
        if (entry.externalSubjectId && entry.externalSubjectId.type !== 'ExternalReference') {
          report({
            severity: 'error',
            elementType: 'AssetInformation',
            key: shell.idShort ?? shell.id,
            pointer: `${base}/externalSubjectId/type`,
            kosmoPath: kosmo,
            message: fill(tr('externalSubjectId가 ExternalReference가 아닙니다: {0}'), {
              0: entry.externalSubjectId.type,
            }),
            remedy: tr('Reference/type을 ExternalReference로 바꾸십시오(AASd-133).'),
            fixable: false,
          });
        }
      });
    });
  },
};

/**
 * AASc-3a-010 — IEC 61360 value and valueList cannot be used together.
 * Must be filtered when opening other people's files (dictionary-based CDs that use value lists).
 */
export const aasc3a010ValueExclusive: Rule = {
  id: 'AASc-3a-010',
  layer: 'L2',
  get title() {
    return tr('IEC 61360의 value와 valueList는 함께 쓸 수 없다');
  },
  get source() {
    return fill(tr('{0} 2장'), { 0: SPEC });
  },
  check(ctx, report) {
    (ctx.environment.conceptDescriptions ?? []).forEach((cd, index) => {
      const content = iec61360Of(cd) as unknown as
        | { value?: unknown; valueList?: { valueReferencePairs?: unknown[] } }
        | undefined;
      if (!content) return;
      const hasValue = content.value !== undefined && content.value !== '';
      const hasList = (content.valueList?.valueReferencePairs?.length ?? 0) > 0;
      if (hasValue && hasList) {
        report({
          severity: 'error',
          elementType: 'ConceptDescription',
          key: cd.idShort ?? cd.id,
          pointer: `/conceptDescriptions/${index}/embeddedDataSpecifications/0/dataSpecificationContent/value`,
          kosmoPath: `/conceptDescriptions/${index}(${cd.idShort ?? cd.id})`,
          message: tr('IEC 61360에 value와 valueList가 함께 있습니다.'),
          remedy: tr('둘 중 하나만 남기십시오(AASc-3a-010) — 고정값이면 value, 선택지면 valueList.'),
          fixable: false,
        });
      }
    });
  },
};

/**
 * AASd-119·129 — TemplateQualifier consistency.
 * Our output does not use Qualifiers, but **other people's files** do (IDTA templates commonly use them).
 */
export const aasdTemplateQualifier: Rule = {
  id: 'AASd-119/129',
  layer: 'L2',
  get title() {
    return tr('TemplateQualifier가 붙은 요소는 kind=Template 서브모델 안에 있어야 한다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    const submodelKind = new Map<number, string | undefined>();
    (ctx.environment.submodels ?? []).forEach((sm, i) => submodelKind.set(i, sm.kind));

    for (const v of ctx.elements) {
      const raw = v.node as unknown as Record<string, unknown>;
      const qualifiers = raw['qualifiers'] as { kind?: string }[] | undefined;
      if (!qualifiers?.some((q) => q.kind === 'TemplateQualifier')) continue;

      // kind of the submodel this element belongs to — found from the first segment of the pointer
      const match = /^\/submodels\/(\d+)\//.exec(v.pointer);
      const kind = match ? submodelKind.get(Number(match[1])) : undefined;
      if (kind === 'Template') continue;
      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/qualifiers`,
        kosmoPath: v.kosmoPath,
        message: fill(tr('TemplateQualifier가 있는데 서브모델 kind가 Template이 아닙니다: {0}'), { 0: kind ?? tr('없음') }),
        remedy: tr('Submodel.kind를 Template으로 바꾸거나 qualifier를 지우십시오(AASd-119·129).'),
        fixable: false,
      });
    }
  },
};

/**
 * AASd-130 — strings may contain only XML 1.0 characters.
 * If control characters or lone surrogates slip in, **XML serialization tools cannot write the file**.
 * JSON lets these characters through, so they pass silently on our path (JSON)
 * and blow up in other tools — which is why we catch them here.
 */
export const aasd130StringChars: Rule = {
  id: 'AASd-130',
  layer: 'L2',
  get title() {
    return tr('문자열에 XML 1.0에서 금지된 문자(제어문자 등)를 쓸 수 없다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    // Forbidden: C0 control characters (except tab and newline) · FFFE/FFFF · lone surrogates
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
    const lonely = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

    const walk = (value: unknown, pointer: string, owner: string): void => {
      if (typeof value === 'string') {
        if (bad.test(value) || lonely.test(value)) {
          report({
            severity: 'error',
            elementType: owner,
            key: pointer.slice(pointer.lastIndexOf('/') + 1),
            pointer,
            kosmoPath: pointer,
            message: tr('문자열에 XML에서 금지된 문자(제어문자 등)가 들어 있습니다.'),
            remedy: tr('해당 문자를 지우십시오(AASd-130). 복사·붙여넣기로 섞여 들어오는 일이 흔합니다.'),
            fixable: false,
          });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${pointer}/${index}`, owner));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const nextOwner = typeof record['modelType'] === 'string' ? String(record['modelType']) : owner;
      for (const [key, child] of Object.entries(record)) walk(child, `${pointer}/${key}`, nextOwner);
    };
    walk(ctx.environment as unknown, '', 'Environment');
  },
};

/**
 * AASd-134 — Operation variable idShorts must be unique.
 * Operation itself is out of project scope (flagged by KOSMO-SME-2), but this must also be checked when opening other people's files.
 */
export const aasd134OperationVariables: Rule = {
  id: 'AASd-134',
  layer: 'L2',
  get title() {
    return tr('Operation의 입·출력 변수 idShort는 서로 달라야 한다');
  },
  get source() {
    return fill(tr('{0} 1장'), { 0: SPEC });
  },
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'Operation') continue;
      const raw = v.node as unknown as Record<string, unknown>;
      const names: string[] = [];
      for (const field of ['inputVariables', 'outputVariables', 'inoutputVariables']) {
        for (const variable of (raw[field] as { value?: { idShort?: string } }[] | undefined) ?? []) {
          if (variable.value?.idShort) names.push(variable.value.idShort);
        }
      }
      const seen = new Set<string>();
      for (const name of names) {
        if (seen.has(name)) {
          report({
            severity: 'error',
            elementType: 'Operation',
            key: v.node.idShort ?? v.idShortPath,
            pointer: v.pointer,
            kosmoPath: v.kosmoPath,
            message: fill(tr('Operation 변수 idShort가 겹칩니다: {0}'), { 0: name }),
            remedy: tr('입·출력 변수의 idShort를 서로 다르게 지으십시오(AASd-134).'),
            fixable: false,
          });
          break;
        }
        seen.add(name);
      }
    }
  },
};

export const L2_RULES: readonly Rule[] = [
  aasd090DataElementCategory,
  aasd120SmlChildIdShort,
  aasd005Administration,
  aasd014Entity,
  aasd022UniqueIdShort,
  aasdSubmodelElementList,
  aasdReferenceKeys,
  aasd118SupplementalSemantics,
  aasdSpecificAssetId,
  aasc3a002PreferredName,
  aasc3a009UnitRequired,
  aasc3a010ValueExclusive,
  aasdTemplateQualifier,
  aasd130StringChars,
  aasd134OperationVariables,
];
