/**
 * Hierarchy checks — process level (IDTA 02011 HierarchicalStructures).
 *
 * Important: these rules are **not measured against the KOSMO Validator.** docs/rules were settled by submitting
 *    the 20 equipment types 4 times; process-level files have no submission record. These are our own rules checking
 *    "is the process file internally consistent", based on IDTA 02011 and the V3.0 metamodel.
 *    Once the operating agency answers, they can be promoted to or demoted from KOSMO rules.
 *
 * Why this is needed: a process file **does not contain equipment details itself.** It only points to equipment files
 * through a single thread, `globalAssetId`, so if that thread breaks the file alone still looks fine.
 * We guard the places where it can break ahead of time.
 */
import type { Entity, Submodel, SubmodelElement } from '@aas/core';
import { fill, tr } from '@aas/core';
import { childNodes, findEntryNode, HIERARCHY_SUBMODEL_ID_SHORT } from '../hierarchy.js';
import type { LintContext, Report, Rule } from '../types.js';

const SOURCE = 'IDTA 02011 Hierarchical Structures · AASd-014';

/** Find the hierarchy submodel. If absent, these rules say nothing (equipment files are like that) */
function hierarchySubmodels(ctx: LintContext): { submodel: Submodel; pointer: string }[] {
  const out: { submodel: Submodel; pointer: string }[] = [];
  (ctx.environment.submodels ?? []).forEach((submodel, i) => {
    if (submodel.idShort !== HIERARCHY_SUBMODEL_ID_SHORT) return;
    // Important: skip hierarchies with nothing filled in yet. **Not filled in is different from filled in wrongly** —
    //    the equipment skeleton leaves this submodel empty and fills it later, and that is not a violation
    //    (we must not break the existing promise that an equipment skeleton has 0 violations the moment it is created).
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
  get title() {
    return tr('계층 구조 진입점 검사 — EntryNode와 ArcheType이 있어야 한다');
  },
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
          message: tr('계층 구조에 진입점(EntryNode)이 없습니다.'),
          remedy: tr('무엇의 계층인지 나타내는 Entity를 최상위에 하나 두십시오.'),
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
          message: tr('ArcheType이 없습니다 — 계층을 어느 방향으로 적었는지 알 수 없습니다.'),
          remedy: tr('ArcheType Property를 두고 Full · OneDown · OneUp 중 하나를 값으로 넣으십시오.'),
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
            message: fill(tr('ArcheType 값이 규격에 없습니다: {0}'), { 0: value }),
            remedy: tr('Full · OneDown · OneUp 중 하나여야 합니다.'),
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
  get title() {
    return tr('자식 노드 연결 검사 — 가리키는 설비 주소(globalAssetId)가 있어야 한다');
  },
  source: SOURCE,
  check(ctx: LintContext, report: Report) {
    for (const { submodel, pointer } of hierarchySubmodels(ctx)) {
      const entry = findEntryNode(submodel);
      if (!entry) continue;
      const entryAsset = assetIdOf(entry);
      const seen = new Map<string, string>();

      for (const child of childNodes(entry)) {
        const key = child.idShort ?? tr('(이름 없음)');
        const asset = assetIdOf(child);
        const at = `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${key}`;

        // Important: AASd-014 — a SelfManagedEntity must have globalAssetId or specificAssetId
        if (child.entityType === 'SelfManagedEntity' && !asset) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: tr('가리키는 설비의 Asset 주소(globalAssetId)가 없습니다.'),
            remedy: tr('그 설비 파일의 AssetInformation.globalAssetId 값을 넣으십시오.'),
            fixable: false,
          });
          continue;
        }
        if (!asset) continue;

        // Attaching itself as its own part is not a hierarchy
        if (entryAsset && asset === entryAsset) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: tr('자기 자신을 부분품으로 매달았습니다.'),
            remedy: tr('자식 노드는 다른 설비의 Asset을 가리켜야 합니다.'),
            fixable: false,
          });
        }
        // Attaching the same equipment twice throws off both the quantity calculation and the relations
        const first = seen.get(asset);
        if (first) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: at,
            message: fill(tr('같은 설비가 이미 매달려 있습니다: {0}'), { 0: first }),
            remedy: tr('중복을 지우십시오. 같은 것이 여러 대면 BulkCount로 적습니다.'),
            fixable: false,
          });
        } else {
          seen.set(asset, key);
        }
      }
    }
  },
};

/** Name of the last target a relation points to — references take the form [Submodel, Entity(parent), Entity(child)] */
function referencedName(reference: unknown): string | undefined {
  const keys = (reference as { keys?: { type?: string; value?: string }[] } | undefined)?.keys;
  if (!keys || keys.length === 0) return undefined;
  return keys[keys.length - 1]?.value;
}

export const hier3HasPart: Rule = {
  id: 'HIER-3',
  layer: 'L3',
  get title() {
    return tr('부분품 관계 검사 — 자식마다 HasPart 관계가 있어야 한다');
  },
  source: SOURCE,
  check(ctx: LintContext, report: Report) {
    for (const { submodel, pointer } of hierarchySubmodels(ctx)) {
      const entry = findEntryNode(submodel);
      if (!entry) continue;
      const statements = statementsOf(entry);

      // Important: do **not pair by relation name.** Measured files name them freely —
      //    HasPart_System_CFrame · HasPart_Robot_Base · HasPart_J2_Reducer.
      //    assuming a naming rule (HasPart_<childName>) failed 2 golden files that had passed the Validator.
      //    The actual link lives in the first/second references, so that is what we check.
      const linked = new Set<string>();
      const relations: { idShort: string; target: string | undefined }[] = [];
      for (const element of statements) {
        if (element.modelType !== 'RelationshipElement') continue;
        const target = referencedName((element as unknown as { second?: unknown }).second);
        relations.push({ idShort: element.idShort ?? tr('(이름 없음)'), target });
        if (target) linked.add(target);
      }

      for (const child of childNodes(entry)) {
        const key = child.idShort ?? tr('(이름 없음)');
        if (!linked.has(key)) {
          report({
            severity: 'error',
            elementType: 'Entity',
            key,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${key}`,
            message: tr('이 자식에 대응하는 HasPart 관계가 없습니다.'),
            remedy: fill(tr('second가 {0}를 가리키는 RelationshipElement를 두어 부모와 연결해 주십시오.'), { 0: key }),
            fixable: false,
          });
        }
      }

      // The reverse — a relation exists but the child does not. Deleting only the child leaves this behind
      const names = new Set(childNodes(entry).map((c) => c.idShort ?? ''));
      for (const relation of relations) {
        if (relation.target !== undefined && !names.has(relation.target)) {
          report({
            severity: 'error',
            elementType: 'RelationshipElement',
            key: relation.idShort,
            pointer: `${pointer}/submodelElements`,
            kosmoPath: `${pointer}(${submodel.idShort})/submodelElements/${entry.idShort}/${relation.idShort}`,
            message: fill(tr('관계가 가리키는 자식이 없습니다: {0}'), { 0: relation.target }),
            remedy: tr('자식을 되살리거나 이 관계를 지우십시오.'),
            fixable: false,
          });
        }
      }
    }
  },
};

export const HIERARCHY_RULES: readonly Rule[] = [hier1EntryNode, hier2NodeAssetId, hier3HasPart];
