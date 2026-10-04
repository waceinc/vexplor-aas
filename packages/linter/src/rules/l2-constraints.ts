/**
 * L2 — AASd / AASc-3a 제약조건.
 *
 * 전 25개 중 코드로 AASX를 생성할 때 실수하기 쉬운 것만 구현한다.
 * 나머지는 정상적인 객체 모델을 쓰면 구조적으로 보장된다(명세 §1 L2).
 *
 * 🔴 AASd-090 · AASd-120은 **구현한다**(2026-08-24 정정). 예전 이 주석은 "V3에서 삭제됐다"고
 *    적었으나 사실이 아니다 — aas-core-meta v3에 둘 다 있다. 맞는 서술은 이것이다:
 *    **KOSMO Validator가 검사하지 않을 뿐이다.** 표준 도구는 강제한다(aas-test-engines 오류 9건,
 *    basyx-python-sdk는 SML 하위 트리를 조용히 잃는다). 자세한 내력은 docs/PROGRESS.md §4.
 *
 * KOSMO 규칙과 겹치는 항목은 여기서 다시 보고하지 않는다:
 *   AASd-002/117 → KOSMO-*-1 (idShort), AASd-131 → KOSMO-AAS-5,
 *   AASc-3a-004 → KOSMO-CD-4, AASc-3a-008 → KOSMO-CD-3
 */
import type { Entity, Property, Reference, SubmodelElementList } from '@aas/core';
import { GLOBALLY_IDENTIFIABLE } from '@aas/core';

/** AASd-123 — 모델 참조의 첫 키로 허용되는 것 */
const AAS_IDENTIFIABLES = ['AssetAdministrationShell', 'Submodel', 'ConceptDescription'];
import type { LintContext, Report, Rule } from '../types.js';
import { firstKeyValue, hasLanguage, iec61360Of, needsUnit } from '../util.js';

const SPEC = 'AAS 참조모델 제약조건 spec_260812.pdf';

export const aasd005Administration: Rule = {
  id: 'AASd-005',
  layer: 'L2',
  title: 'version 없이 revision을 지정할 수 없다',
  source: `${SPEC} 1장`,
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
        message: 'version 없이 revision만 지정되어 있습니다.',
        remedy: 'administration에 version을 함께 입력하십시오.',
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
  title: 'SelfManagedEntity는 globalAssetId 또는 specificAssetId를 가져야 한다',
  source: `${SPEC} 1장`,
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
        message: 'SelfManagedEntity에 globalAssetId도 specificAssetIds도 없습니다.',
        remedy: '자산 식별자를 지정하거나 entityType을 CoManagedEntity로 바꾸십시오.',
        fixable: false,
      });
    }
  },
};

export const aasd022UniqueIdShort: Rule = {
  id: 'AASd-022',
  layer: 'L2',
  title: '같은 네임스페이스 안에서 idShort는 고유해야 한다 (대소문자 구분)',
  source: `${SPEC} 1장`,
  check(ctx, report) {
    // 네임스페이스 = 부모 컨테이너. 부모 pointer를 키로 묶는다
    const groups = new Map<string, Map<string, number>>();

    for (const v of ctx.elements) {
      // SML 직계 자식은 순서로 식별되므로 고유성 대상이 아니다
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
          message: `같은 네임스페이스에 동일한 idShort가 이미 있습니다: ${idShort}`,
          remedy: '형제 요소끼리 이름이 겹치지 않도록 바꾸십시오. 대소문자만 다른 것도 허용되지 않습니다.',
          fixable: false,
        });
      }
      bucket.set(idShort, seen + 1);
      groups.set(parentPointer, bucket);
    }
  },
};

/** AASd-107 / 108 / 109 / 114 — SubmodelElementList 계열 제약 */
export const aasdSubmodelElementList: Rule = {
  id: 'AASd-107/108/109/114',
  layer: 'L2',
  title: 'SubmodelElementList 직계 자식의 타입·semanticId·valueType 일관성',
  source: `${SPEC} 1장`,
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (v.node.modelType !== 'SubmodelElementList') continue;
      const list = v.node as SubmodelElementList;
      const children = list.value ?? [];
      if (children.length === 0) continue;

      const key = list.idShort ?? v.idShortPath;

      // AASd-108 — 자식은 모두 typeValueListElement와 같은 타입
      children.forEach((child, i) => {
        if (child.modelType !== list.typeValueListElement) {
          report({
            severity: 'error',
            elementType: 'SubmodelElementList',
            key,
            pointer: `${v.pointer}/value/${i}`,
            kosmoPath: `${v.kosmoPath}/value/${i}`,
            message:
              `자식 요소의 타입이 typeValueListElement와 다릅니다: ` +
              `${child.modelType} (선언값 ${list.typeValueListElement})`,
            remedy: 'SubmodelElementList에는 한 가지 타입만 담을 수 있습니다.',
            fixable: false,
          });
        }
      });

      // AASd-109 — Property/Range를 담으면 valueTypeListElement 필수
      const needsValueType =
        list.typeValueListElement === 'Property' || list.typeValueListElement === 'Range';
      if (needsValueType && !list.valueTypeListElement) {
        report({
          severity: 'error',
          elementType: 'SubmodelElementList',
          key,
          pointer: `${v.pointer}/valueTypeListElement`,
          kosmoPath: v.kosmoPath,
          message: 'Property/Range를 담는 리스트인데 valueTypeListElement가 없습니다.',
          remedy: '자식들이 공통으로 쓰는 valueType을 valueTypeListElement에 지정하십시오.',
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
              message: `자식의 valueType이 valueTypeListElement와 다릅니다: ${childValueType} (선언값 ${list.valueTypeListElement})`,
              remedy: '리스트 안의 값 타입을 통일하십시오.',
              fixable: false,
            });
          }
        });
      }

      // AASd-107 / 114 — 자식 semanticId는 서로 같고 semanticIdListElement와도 일치
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
            message: `직계 자식들의 semanticId가 서로 다릅니다: ${distinct.length}종`,
            remedy: '리스트 자식은 모두 같은 semanticId를 가져야 합니다(AASd-114).',
            fixable: false,
          });
        } else if (declared !== undefined && distinct[0] !== declared) {
          report({
            severity: 'error',
            elementType: 'SubmodelElementList',
            key,
            pointer: `${v.pointer}/semanticIdListElement`,
            kosmoPath: v.kosmoPath,
            message: `자식의 semanticId가 semanticIdListElement와 다릅니다: ${distinct[0]} (선언값 ${declared})`,
            // 🔴 자동으로 고치지 않는다 — 어느 쪽이 맞는지는 사람이 안다. 실측: 자식이 「345345」(오타), 선언값이 표준 IRDI.
            //    fixable로 광고하면서 교정기가 없어 단추 숫자와 팝업이 어긋났다(2026-09-11)
            remedy:
              '둘 중 맞는 쪽으로 맞추십시오 — 대개 표준 사전 값(0173-/0112/로 시작)이 맞고 자식 쪽이 오타입니다. ' +
              '자식 요소를 골라 semanticId 칸에서 선언값을 넣으면 됩니다(AASd-107).',
            fixable: false,
          });
        }
      }
    }
  },
};

/** AASd-121 / 122 / 124 — Reference 키 규칙 */
export const aasdReferenceKeys: Rule = {
  id: 'AASd-121~128',
  layer: 'L2',
  title: 'Reference 키 사슬 — 첫 키·뒤 키·Fragment 자리의 타입 제약',
  source: `${SPEC} 1장`,
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
          message: `Reference의 첫 키가 GloballyIdentifiable이 아닙니다: ${first.type}`,
          remedy: `첫 키 타입을 ${GLOBALLY_IDENTIFIABLE.join(' / ')} 중 하나로 바꾸십시오(AASd-121).`,
          fixable: true,
        });
      }

      if (ref.type === 'ModelReference') {
        // AASd-123 — 모델 참조의 첫 키는 AAS·Submodel·ConceptDescription 중 하나여야 한다
        if (!AAS_IDENTIFIABLES.includes(first.type)) {
          report2({
            severity: 'error',
            elementType,
            key,
            pointer: `${pointer}/${field}/keys/0/type`,
            kosmoPath,
            message: `ModelReference의 첫 키가 AAS 식별 대상이 아닙니다: ${first.type}`,
            remedy: `첫 키 타입을 ${AAS_IDENTIFIABLES.join(' / ')} 중 하나로 바꾸십시오(AASd-123).`,
            fixable: false,
          });
        }
        // AASd-125/126 — 둘째 키부터는 Fragment류를 제외한 요소 타입이어야 한다
        // (마지막 키의 FragmentReference는 126이 허용한다)
        ref.keys.slice(1).forEach((chainKey, offset) => {
          const index = offset + 1;
          const isLast = index === ref.keys.length - 1;
          if (chainKey.type === 'FragmentReference' && isLast) {
            // AASd-127 — FragmentReference 앞 키는 File·Blob이어야 한다
            const previous = ref.keys[index - 1];
            if (previous && previous.type !== 'File' && previous.type !== 'Blob') {
              report2({
                severity: 'error',
                elementType,
                key,
                pointer: `${pointer}/${field}/keys/${index}/type`,
                kosmoPath,
                message: `FragmentReference 앞 키가 File·Blob이 아닙니다: ${previous.type}`,
                remedy: 'Fragment는 파일 안 위치를 가리킵니다 — 앞 키를 File 또는 Blob으로(AASd-127).',
            fixable: false,
              });
            }
            return;
          }
          // AASd-128 — SubmodelElementList 키 뒤의 값은 배열 위치(정수)여야 한다
          const previousKey = ref.keys[index - 1];
          if (previousKey?.type === 'SubmodelElementList' && !/^\d+$/.test(chainKey.value)) {
            report2({
              severity: 'error',
              elementType,
              key,
              pointer: `${pointer}/${field}/keys/${index}/value`,
              kosmoPath,
              message: `SubmodelElementList 키 뒤의 값이 정수 색인이 아닙니다: ${chainKey.value}`,
              remedy: '리스트 자식은 위치로 가리킵니다 — 0부터 시작하는 숫자를 쓰십시오(AASd-128).',
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
              message: `ModelReference의 ${index + 1}번째 키 타입이 요소류가 아닙니다: ${chainKey.type}`,
              remedy:
                '둘째 키부터는 Property·SubmodelElementCollection 같은 요소 타입이어야 합니다(AASd-125).',
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
            message: `ExternalReference의 첫 키가 GlobalReference가 아닙니다: ${first.type}`,
            remedy:
              'GlobalReference로 바꾸십시오. Submodel로 두면 AASd-122 위반이며 ' +
              'basyx가 해당 서브모델을 통째로 드롭합니다(실측 7→5).',
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
            message: `ExternalReference의 마지막 키가 GlobalReference가 아닙니다: ${last.type}`,
            remedy: '마지막 키 타입을 GlobalReference로 바꾸십시오(AASd-124).',
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
  title: 'ConceptDescription의 preferredName에 영문이 있어야 한다',
  source: `${SPEC} 2장`,
  check(ctx, report) {
    (ctx.environment.conceptDescriptions ?? []).forEach((cd, i) => {
      const content = iec61360Of(cd);
      if (!content) return; // KOSMO-CD-4가 보고한다
      if (hasLanguage(content.preferredName, 'en')) return;

      const key = cd.idShort ?? cd.id;
      report({
        severity: 'error',
        elementType: 'ConceptDescription',
        key,
        pointer: `/conceptDescriptions/${i}/embeddedDataSpecifications/0/dataSpecificationContent/preferredName`,
        kosmoPath: `/conceptDescriptions/${i}(${key})/preferredName`,
        message: 'preferredName에 영문(en) 항목이 없습니다.',
        remedy: '영문 표기를 en 태그로 추가하십시오.',
        fixable: true,
      });
    });
  },
};

export const aasc3a009UnitRequired: Rule = {
  id: 'AASc-3a-009',
  layer: 'L2',
  title: 'dataType이 MEASURE/CURRENCY 계열이면 unit 또는 unitId가 필요하다',
  source: `${SPEC} 2장`,
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
        message: `dataType이 ${content.dataType}인데 unit도 unitId도 없습니다.`,
        remedy:
          '단위를 지정하십시오. 무차원 값(개수·비율·역률)이라면 단위를 억지로 붙이지 말고 ' +
          'dataType을 REAL_COUNT / INTEGER_COUNT로 바꾸는 것이 옳습니다.',
        fixable: true,
      });
    });
  },
};

/**
 * AASd-120 — SubmodelElementList 직계 자식은 idShort를 가질 수 없다.
 *
 * 🔴 이 규칙의 내력을 알아야 한다(2026-08-24 실측으로 정정).
 * 예전 이 저장소는 "AASd-120은 V3에서 삭제됐다"고 적어 두고 구현하지 않았다. **사실이 아니다.**
 * 규격(V3.0)에 그대로 있고(aas-core-meta v3 SubmodelElementList), KOSMO Validator가
 * 검사하지 않을 뿐이다. 표준 도구는 강제한다 —
 *   · `aas-test-engines` 1.0.3: 골든 파일을 **오류 9건**으로 떨어뜨린다
 *   · `basyx-python-sdk`: 파일을 아예 읽지 못한다(서브모델 드롭)
 * 실측: 골든 파일에서 SML 자식 idShort 10개를 빼면 aas-test-engines **오류 0건**이 되고,
 * KOSMO 규칙 위반은 그대로 0건이다. 즉 **빼는 쪽이 양쪽을 다 만족한다.**
 *
 * 기본 등급을 경고로 둔 이유: KOSMO 제출을 막을 이유는 없고(검사하지 않는다),
 * 상호운용이 깨진다는 사실은 반드시 알려야 하기 때문이다. 정책으로 승격·강등할 수 있다.
 */
export const aasd120SmlChildIdShort: Rule = {
  id: 'AASd-120',
  layer: 'L2',
  title: 'SubmodelElementList 직계 자식은 idShort를 가질 수 없다',
  source: 'AAS V3.0 메타모델 AASd-120 (aas-core-meta v3) · aas-test-engines 1.0.3 실측',
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
        message: `SubmodelElementList의 직계 자식에 idShort가 있습니다: ${idShort}`,
        remedy:
          'idShort를 지우십시오. 리스트 자식은 인덱스로 가리킵니다(AASd-120). ' +
          '지워도 KOSMO 규칙에는 영향이 없고, BaSyx 적재와 표준 검증기 통과가 열립니다. ' +
          // 🔴 이미 Validator를 받은 파일은 고치면 해시가 달라진다 — 번들은 원본 바이트로 대조한다(2026-09-30)
          '단, 이미 Validator를 받아 제출한 파일은 고치면 파일이 달라지므로 다음 판에서 고치고 Validator를 다시 받으십시오.',
        fixable: true,
        policyNote:
          policy === 'forbid'
            ? '정책(forbid) — 표준 준수·상호운용을 우선합니다.'
            : 'KOSMO Validator는 이 제약을 검사하지 않지만, aas-test-engines는 오류로, ' +
              'basyx-python-sdk는 읽기 실패로 처리합니다. 정책(warn)에 따라 경고로 표시했습니다.',
      });
    }
  },
};

/**
 * AASd-090 — DataElement의 category는 CONSTANT · PARAMETER · VARIABLE 중 하나.
 *
 * 이것도 "V3 삭제분"으로 적혀 있었으나 **규격에 있다**(aas-core-meta v3 DataElement).
 * 다만 *비워 두면 무관*하다는 서술은 맞다 — 값이 있을 때만 걸리는 제약이다.
 * 설비 20종은 category를 쓰지 않아 지금까지 드러나지 않았고, 저작 UI에서 category를
 * 넣을 수 있게 된 뒤로는 사람이 잘못 넣을 수 있어 검사한다.
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
  title: 'DataElement의 category는 CONSTANT · PARAMETER · VARIABLE 중 하나여야 한다',
  source: 'AAS V3.0 메타모델 AASd-090 (aas-core-meta v3)',
  check(ctx, report) {
    for (const v of ctx.elements) {
      if (!DATA_ELEMENT_TYPES.has(v.node.modelType)) continue;
      const category = v.node.category;
      // 비워 두는 것은 규격상 문제가 없다
      if (category === undefined || category === '') continue;
      if (ALLOWED_CATEGORIES.includes(category)) continue;

      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/category`,
        kosmoPath: `${v.kosmoPath}/category`,
        message: `DataElement의 category가 허용값이 아닙니다: ${category}`,
        remedy: `${ALLOWED_CATEGORIES.join(' · ')} 중 하나로 바꾸거나 비워 두십시오(AASd-090).`,
        fixable: true,
      });
    }
  },
};

/**
 * AASd-118 — supplementalSemanticIds가 있으면 semanticId도 있어야 한다.
 *
 * 우리 산출물이 실제로 걸릴 수 있는 자리다: 골든 파일이 supplementalSemanticIds를 쓰고
 * (IDTA 원본 IRI 보존), 화면에서 semanticId를 비우면 이 제약이 깨진다.
 */
export const aasd118SupplementalSemantics: Rule = {
  id: 'AASd-118',
  layer: 'L2',
  title: 'supplementalSemanticIds가 있으면 semanticId도 있어야 한다',
  source: `${SPEC} 1장`,
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
        message: '보조 semanticId만 있고 주 semanticId가 없습니다.',
        remedy: 'semanticId를 채우거나 supplementalSemanticIds를 지우십시오(AASd-118).',
        fixable: false,
      });
    }
  },
};

/**
 * AASd-116·133 — SpecificAssetId의 예약 이름과 externalSubjectId 타입.
 * 우리 도구는 이 구조를 만들지 않지만, **남의 파일을 열 때** 걸러야 한다(XML 열기 지원 이후).
 */
export const aasdSpecificAssetId: Rule = {
  id: 'AASd-116/133',
  layer: 'L2',
  title: 'SpecificAssetId — 예약 이름 globalAssetId 금지, externalSubjectId는 ExternalReference',
  source: `${SPEC} 1장`,
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
            message: 'specificAssetId의 이름으로 예약어 globalAssetId를 쓸 수 없습니다.',
            remedy: '그 값은 assetInformation.globalAssetId 필드에 두십시오(AASd-116).',
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
            message: `externalSubjectId가 ExternalReference가 아닙니다: ${entry.externalSubjectId.type}`,
            remedy: 'Reference/type을 ExternalReference로 바꾸십시오(AASd-133).',
            fixable: false,
          });
        }
      });
    });
  },
};

/**
 * AASc-3a-010 — IEC 61360의 value와 valueList는 함께 쓸 수 없다.
 * 남의 파일(값 목록을 쓰는 사전 기반 CD)을 열 때 걸러야 한다.
 */
export const aasc3a010ValueExclusive: Rule = {
  id: 'AASc-3a-010',
  layer: 'L2',
  title: 'IEC 61360의 value와 valueList는 함께 쓸 수 없다',
  source: `${SPEC} 2장`,
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
          message: 'IEC 61360에 value와 valueList가 함께 있습니다.',
          remedy: '둘 중 하나만 남기십시오(AASc-3a-010) — 고정값이면 value, 선택지면 valueList.',
          fixable: false,
        });
      }
    });
  },
};

/**
 * AASd-119·129 — TemplateQualifier의 일관성.
 * 산출물은 Qualifier를 쓰지 않지만 **남의 파일**에는 있다(IDTA 템플릿이 흔히 쓴다).
 */
export const aasdTemplateQualifier: Rule = {
  id: 'AASd-119/129',
  layer: 'L2',
  title: 'TemplateQualifier가 붙은 요소는 kind=Template 서브모델 안에 있어야 한다',
  source: `${SPEC} 1장`,
  check(ctx, report) {
    const submodelKind = new Map<number, string | undefined>();
    (ctx.environment.submodels ?? []).forEach((sm, i) => submodelKind.set(i, sm.kind));

    for (const v of ctx.elements) {
      const raw = v.node as unknown as Record<string, unknown>;
      const qualifiers = raw['qualifiers'] as { kind?: string }[] | undefined;
      if (!qualifiers?.some((q) => q.kind === 'TemplateQualifier')) continue;

      // 이 요소가 속한 서브모델의 kind — pointer 첫 마디에서 찾는다
      const match = /^\/submodels\/(\d+)\//.exec(v.pointer);
      const kind = match ? submodelKind.get(Number(match[1])) : undefined;
      if (kind === 'Template') continue;
      report({
        severity: 'error',
        elementType: v.node.modelType,
        key: v.node.idShort ?? v.idShortPath,
        pointer: `${v.pointer}/qualifiers`,
        kosmoPath: v.kosmoPath,
        message: `TemplateQualifier가 있는데 서브모델 kind가 Template이 아닙니다: ${kind ?? '없음'}`,
        remedy: 'Submodel.kind를 Template으로 바꾸거나 qualifier를 지우십시오(AASd-119·129).',
        fixable: false,
      });
    }
  },
};

/**
 * AASd-130 — 문자열은 XML 1.0 문자만.
 * 제어문자·홀 서로게이트가 섞이면 **XML 직렬화 도구가 그 파일을 못 쓴다**.
 * JSON은 이런 문자를 통과시키므로 우리 경로(JSON)에서는 조용히 지나가다
 * 다른 도구에서 터진다 — 그래서 여기서 잡는다.
 */
export const aasd130StringChars: Rule = {
  id: 'AASd-130',
  layer: 'L2',
  title: '문자열에 XML 1.0에서 금지된 문자(제어문자 등)를 쓸 수 없다',
  source: `${SPEC} 1장`,
  check(ctx, report) {
    // 금지: C0 제어문자(탭·줄바꿈 제외) · FFFE/FFFF · 홀 서로게이트
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
            message: '문자열에 XML에서 금지된 문자(제어문자 등)가 들어 있습니다.',
            remedy: '해당 문자를 지우십시오(AASd-130). 복사·붙여넣기로 섞여 들어오는 일이 흔합니다.',
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
 * AASd-134 — Operation 변수 idShort 유일.
 * Operation 자체는 사업 밖(KOSMO-SME-2가 지적)이지만, 남의 파일을 열 때는 이것도 봐야 한다.
 */
export const aasd134OperationVariables: Rule = {
  id: 'AASd-134',
  layer: 'L2',
  title: 'Operation의 입·출력 변수 idShort는 서로 달라야 한다',
  source: `${SPEC} 1장`,
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
            message: `Operation 변수 idShort가 겹칩니다: ${name}`,
            remedy: '입·출력 변수의 idShort를 서로 다르게 지으십시오(AASd-134).',
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
