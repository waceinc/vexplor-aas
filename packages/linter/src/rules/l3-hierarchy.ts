/**
 * 계층 구조 검사 — 공정 단위(IDTA 02011 HierarchicalStructures).
 *
 * 🔴 이 규칙들은 **KOSMO Validator 실측이 아니다.** docs/rules는 설비 20종을 4회 제출해
 *    확정한 것이고, 공정 단위는 제출 실적이 없다. 여기 있는 것은 "공정 파일이 스스로
 *    앞뒤가 맞는가"를 보는 우리 규칙이며, 근거는 IDTA 02011과 V3.0 메타모델이다.
 *    운영기관 답이 오면 그때 KOSMO 규칙으로 승격하거나 내리면 된다.
 *
 * 왜 필요한가: 공정 파일은 **자기 안에 설비 상세를 담지 않는다.** `globalAssetId`라는
 * 끈 하나로 설비 파일을 가리킬 뿐이라, 그 끈이 끊어져도 파일만 봐서는 멀쩡해 보인다.
 * 끊어질 수 있는 자리를 미리 막는다.
 */
import type { Entity, Submodel, SubmodelElement } from '@aas/core';
import { childNodes, findEntryNode, HIERARCHY_SUBMODEL_ID_SHORT } from '../hierarchy.js';
import type { LintContext, Report, Rule } from '../types.js';

const SOURCE = 'IDTA 02011 Hierarchical Structures · AASd-014';

/** 계층 서브모델을 찾는다. 없으면 이 규칙들은 아무 말도 하지 않는다(설비 파일이 그렇다) */
function hierarchySubmodels(ctx: LintContext): { submodel: Submodel; pointer: string }[] {
  const out: { submodel: Submodel; pointer: string }[] = [];
  (ctx.environment.submodels ?? []).forEach((submodel, i) => {
    if (submodel.idShort !== HIERARCHY_SUBMODEL_ID_SHORT) return;
    // 🔴 아직 아무것도 안 적은 계층은 건너뛴다. **안 적은 것과 잘못 적은 것은 다르다** —
    //    설비 뼈대는 이 서브모델을 빈 채로 두고 나중에 채우며, 그건 위반이 아니다
    //    (설비 뼈대가 태어나자마자 위반 0건이어야 한다는 기존 약속을 깨면 안 된다).
    if (((submodel.submodelElements ?? []) as SubmodelElement[]).length === 0) return;
    out.push({ submodel, pointer: `/submodels/${i}` });
  });
  return out;
}

function statementsOf(entity: Entity): SubmodelElement[] {
  return (entity as unknown as { statements?: SubmodelElement[] }).statements ?? [];
}

function assetIdOf(entity: Entity): string | undefined {
  return (entity as unknown as { globalAssetId?: string }).globalAssetId;
}

export const hier1EntryNode: Rule = {
  id: 'HIER-1',
  layer: 'L3',
  title: '계층 구조 진입점 검사 — EntryNode와 ArcheType이 있어야 한다',
  source: SOURCE,
  check(ctx: LintContext, report: Report) {
    for (const { submodel, pointer } of hierarchySubmodels(ctx)) {
      const key = submodel.idShort ?? submodel.id;
      const entry = findEntryNode(submodel);
      if (!entry) {
        report({
          severity: 'error',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/submodelElements`,
          kosmoPath: `${pointer}(${key})/submodelElements`,
          message: '계층 구조에 진입점(EntryNode)이 없습니다.',
          remedy: '무엇의 계층인지 나타내는 Entity를 최상위에 하나 두십시오.',
          fixable: false,
        });
        continue;
      }
      const elements = (submodel.submodelElements ?? []) as SubmodelElement[];
      const archeType = elements.find((e) => e.idShort === 'ArcheType');
      if (!archeType) {
        report({
          severity: 'warning',
          elementType: 'Submodel',
          key,
          pointer: `${pointer}/submodelElements`,
          kosmoPath: `${pointer}(${key})/submodelElements`,
          message: 'ArcheType이 없습니다 — 계층을 어느 방향으로 적었는지 알 수 없습니다.',
          remedy: 'ArcheType Property를 두고 Full · OneDown · OneUp 중 하나를 값으로 넣으십시오.',
          fixable: false,
        });
      } else {
        const value = (archeType as unknown as { value?: string }).value;
        if (value !== undefined && !['Full', 'OneDown', 'OneUp'].includes(value)) {
          report({
            severity: 'error',
            elementType: 'Property',
            key: 'ArcheType',
            pointer: `${pointer}/submodelElements`,
            kosmoPath: `${pointer}(${key})/submodelElements/ArcheType`,
            message: `ArcheType 값이 규격에 없는 것입니다: ${value}`,
            remedy: 'Full · OneDown · OneUp 중 하나여야 합니다.',
            fixable: false,
          });
        }
      }
    }
  },
};

export const hier2NodeAssetId: Rule = {
  id: 'HIER-2',
  layer: 'L3',
  title: '자식 노드 연결 검사 — 가리키는 설비 주소(globalAssetId)가 있어야 한다',
  source: SOURCE,
  check(ctx: LintContext, report: Report) {
    for (const { submodel, pointer } of hierarchySubmodels(ctx)) {
      const entry = findEntryNode(submodel);
      if (!entry) continue;
      const entryAsset = assetIdOf(entry);
      const seen = new Map<string, string>();

      for (const child of childNodes(entry)) {
        const key = child.idShort ?? '(이름 없음)';
        const asset = assetIdOf(child);
        const at = `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${key}`;

        // 🔴 AASd-014 — SelfManagedEntity면 globalAssetId 또는 specificAssetId가 반드시 있어야 한다
        if (child.entityType === 'SelfManagedEntity' && !asset) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: '가리키는 설비의 Asset 주소(globalAssetId)가 없습니다.',
            remedy: '그 설비 파일의 AssetInformation.globalAssetId 값을 넣으십시오.',
            fixable: false,
          });
          continue;
        }
        if (!asset) continue;

        // 자기 자신을 부분품으로 매다는 것은 계층이 아니다
        if (entryAsset && asset === entryAsset) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: '자기 자신을 부분품으로 매달았습니다.',
            remedy: '자식 노드는 다른 설비의 Asset을 가리켜야 합니다.',
            fixable: false,
          });
        }
        // 같은 설비를 두 번 매달면 대수 계산도 관계도 어긋난다
        const first = seen.get(asset);
        if (first) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: `같은 설비가 이미 매달려 있습니다: ${first}`,
            remedy: '중복을 지우십시오. 같은 것이 여러 대면 BulkCount로 적습니다.',
            fixable: false,
          });
        } else {
          seen.set(asset, key);
        }
      }
    }
  },
};

/** 관계가 가리키는 마지막 대상의 이름 — 참조는 [Submodel, Entity(부모), Entity(자식)] 꼴이다 */
function referencedName(reference: unknown): string | undefined {
  const keys = (reference as { keys?: { type?: string; value?: string }[] } | undefined)?.keys;
  if (!keys || keys.length === 0) return undefined;
  return keys[keys.length - 1]?.value;
}

export const hier3HasPart: Rule = {
  id: 'HIER-3',
  layer: 'L3',
  title: '부분품 관계 검사 — 자식마다 HasPart 관계가 있어야 한다',
  source: SOURCE,
  check(ctx: LintContext, report: Report) {
    for (const { submodel, pointer } of hierarchySubmodels(ctx)) {
      const entry = findEntryNode(submodel);
      if (!entry) continue;
      const statements = statementsOf(entry);

      // 🔴 관계의 **이름으로 짝을 맞추지 않는다.** 실측 파일들은 이름을 자유롭게 짓는다 —
      //    HasPart_System_CFrame · HasPart_Robot_Base · HasPart_J2_Reducer.
      //    이름 규칙(HasPart_<자식이름>)을 가정했다가 Validator를 통과한 골든 파일 2종을
      //    떨어뜨렸다. 실제 연결은 first/second 참조에 있으므로 그것을 본다.
      const linked = new Set<string>();
      const relations: { idShort: string; target: string | undefined }[] = [];
      for (const element of statements) {
        if (element.modelType !== 'RelationshipElement') continue;
        const target = referencedName((element as unknown as { second?: unknown }).second);
        relations.push({ idShort: element.idShort ?? '(이름 없음)', target });
        if (target) linked.add(target);
      }

      for (const child of childNodes(entry)) {
        const key = child.idShort ?? '(이름 없음)';
        if (!linked.has(key)) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${key}`,
            message: '이 자식에 대응하는 HasPart 관계가 없습니다.',
            remedy: `second가 ${key}를 가리키는 RelationshipElement를 두어 부모와 이어 주십시오.`,
            fixable: false,
          });
        }
      }

      // 반대쪽 — 관계는 있는데 자식이 없는 경우. 자식만 지우면 이렇게 남는다
      const names = new Set(childNodes(entry).map((c) => c.idShort ?? ''));
      for (const relation of relations) {
        if (relation.target !== undefined && !names.has(relation.target)) {
          report({
            severity: 'error',
            elementType: 'RelationshipElement',
            key: relation.idShort,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${relation.idShort}`,
            message: `관계가 가리키는 자식이 없습니다: ${relation.target}`,
            remedy: '자식을 되살리거나 이 관계를 지우십시오.',
            fixable: false,
          });
        }
      }
    }
  },
};

export const HIERARCHY_RULES: readonly Rule[] = [hier1EntryNode, hier2NodeAssetId, hier3HasPart];
