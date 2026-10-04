/**
 * 계층 구조 — IDTA 02011 `HierarchicalStructures`.
 *
 * "이것은 저것들로 이루어져 있다"를 적는 표준 서브모델이다.
 * 골든 파일(설비 20종)이 이미 이 문법으로 **설비 안쪽 부품**을 적고 있다 —
 * 롤포밍기 → Uncoiler · RollStandUnit(→ FormingRoll · DriveMotor) · CutOffPress.
 *
 * 공정 단위는 이 구조를 **한 칸 위로 올린 것**뿐이다. 문법도 서브모델도 같다.
 *
 *   용접공정(EntryNode) → 롤포밍기(Node) · 협동로봇(Node) · SPR장비(Node)
 *
 * 자식 Node는 자기 상세를 담지 않는다. `globalAssetId`로 **그 설비의 Asset을 가리키기만** 한다.
 * 설비의 상세는 각자 파일에 그대로 둔다(값 동기화 A안과 같은 정신 — 원본은 한 군데다).
 */
import type { Entity, RelationshipElement, Submodel, SubmodelElement } from '@aas/core';

/** IDTA 02011이 정한 것 — 우리가 지어낸 값이 아니다 */
export const IDTA_HIERARCHY = {
  submodel: 'https://admin-shell.io/idta/HierarchicalStructures/1/0/Submodel',
  entryNode: 'https://admin-shell.io/idta/HierarchicalStructures/EntryNode/1/0',
  node: 'https://admin-shell.io/idta/HierarchicalStructures/Node/1/0',
  hasPart: 'https://admin-shell.io/idta/HierarchicalStructures/HasPart/1/0',
  archeType: 'https://admin-shell.io/idta/HierarchicalStructures/ArcheType/1/0',
  bulkCount: 'https://admin-shell.io/idta/HierarchicalStructures/BulkCount/1/0',
} as const;

export const HIERARCHY_SUBMODEL_ID_SHORT = 'HierarchicalStructures';

/**
 * ArcheType — 이 계층을 어느 방향으로 적었는가.
 *  Full     전체를 다 적었다 (공정이 쓰는 것)
 *  OneDown  한 단계 아래까지만
 *  OneUp    자기 위만 가리킨다
 */
export type ArcheType = 'Full' | 'OneDown' | 'OneUp';

/** 자체 IRI(KOSMO)를 쓰되 IDTA 것을 supplemental로 함께 단다 — 충돌 ⑤의 kosmo-first와 같은 방식 */
function semanticPair(ownIri: string, idtaIri: string) {
  return {
    semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: ownIri }] },
    supplementalSemanticIds: [
      { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaIri }] },
    ],
  };
}

export interface NodeInput {
  /** 자식 이름 — idShort가 된다 */
  name: string;
  /** 그 설비의 Asset 주소. 이것이 두 파일을 잇는 유일한 끈이다 */
  globalAssetId: string;
  /** 같은 것이 여러 대면 대수 */
  bulkCount?: number;
}

/** 자식 하나(Entity Node)를 만든다 */
export function buildNode(input: NodeInput, iriBase: string): Entity {
  const node = {
    idShort: input.name,
    modelType: 'Entity',
    entityType: 'SelfManagedEntity',
    // 🔴 SelfManagedEntity는 globalAssetId가 반드시 있어야 한다(AASd-014)
    globalAssetId: input.globalAssetId,
    ...semanticPair(`${iriBase}/cd/Node/1/0`, IDTA_HIERARCHY.node),
  } as unknown as Entity;

  if (input.bulkCount !== undefined && input.bulkCount > 1) {
    (node as unknown as { statements: SubmodelElement[] }).statements = [
      {
        idShort: 'BulkCount',
        modelType: 'Property',
        valueType: 'xs:int',
        value: String(input.bulkCount),
        ...semanticPair(`${iriBase}/cd/BulkCount/1/0`, IDTA_HIERARCHY.bulkCount),
      } as unknown as SubmodelElement,
    ];
  }
  return node;
}

/** 부모 → 자식 관계 하나 */
export function buildHasPart(
  parentSubmodelId: string,
  parentPath: readonly string[],
  childPath: readonly string[],
  iriBase: string,
): RelationshipElement {
  const ref = (path: readonly string[]) => ({
    type: 'ModelReference',
    keys: [
      { type: 'Submodel', value: parentSubmodelId },
      ...path.map((name) => ({ type: 'Entity', value: name })),
    ],
  });
  return {
    idShort: `HasPart_${childPath[childPath.length - 1]}`,
    modelType: 'RelationshipElement',
    first: ref(parentPath),
    second: ref(childPath),
    ...semanticPair(`${iriBase}/cd/HasPart/1/0`, IDTA_HIERARCHY.hasPart),
  } as unknown as RelationshipElement;
}

/**
 * 중간 마디(그룹) — 파일이 따로 없는 층. 회사 파일 안의 「용접공정」 같은 것.
 *
 * 🔴 CoManagedEntity를 쓴다. SelfManagedEntity는 globalAssetId가 필수인데(AASd-014)
 *    그룹은 가리킬 파일이 없다 — 표준이 정확히 이런 경우를 위해 CoManaged를 둔다
 *    (상위 자산에 딸려 관리되는 부분). 골든 파일의 중첩 구조와 같은 문법이다.
 */
export function buildGroupNode(name: string, iriBase: string): Entity {
  return {
    idShort: name,
    modelType: 'Entity',
    entityType: 'CoManagedEntity',
    ...semanticPair(`${iriBase}/cd/Node/1/0`, IDTA_HIERARCHY.node),
  } as unknown as Entity;
}

/** 경로(이름들)로 중첩 Entity를 찾아간다. 빈 경로면 진입점 자신이다 */
export function findByPath(submodel: Submodel, path: readonly string[]): Entity | undefined {
  let current = findEntryNode(submodel);
  for (const name of path) {
    if (!current) return undefined;
    current = childNodes(current).find((child) => child.idShort === name);
  }
  return current;
}

/** 진입점(자기 자신)을 만든다 — 계층의 뿌리다 */
export function buildEntryNode(name: string, globalAssetId: string, iriBase: string): Entity {
  return {
    idShort: name,
    modelType: 'Entity',
    entityType: 'SelfManagedEntity',
    globalAssetId,
    ...semanticPair(`${iriBase}/cd/EntryNode/1/0`, IDTA_HIERARCHY.entryNode),
  } as unknown as Entity;
}

/** 서브모델 안에서 진입점을 찾는다 — 최상위 Entity 중 첫 번째다 */
export function findEntryNode(submodel: Submodel): Entity | undefined {
  const elements = (submodel.submodelElements ?? []) as SubmodelElement[];
  return elements.find((e) => e.modelType === 'Entity') as Entity | undefined;
}

/** 진입점의 자식들(Entity만) */
export function childNodes(entry: Entity): Entity[] {
  const statements = (entry as unknown as { statements?: SubmodelElement[] }).statements ?? [];
  return statements.filter((e) => e.modelType === 'Entity') as Entity[];
}

/**
 * 자식 하나를 계층에 더한다. **있는 것을 고치지 않고 새 서브모델을 돌려준다** —
 * 저장소가 통째로 갈아 끼우는 방식이라(updateIdentifiable) 그 편이 안전하다.
 */
export function addChild(
  submodel: Submodel,
  input: NodeInput | { name: string; group: true },
  iriBase: string,
  /** 어느 마디 밑에 넣을지 — 진입점부터의 이름 경로. 비우면 최상위다 */
  parentPath: readonly string[] = [],
): Submodel {
  const next = JSON.parse(JSON.stringify(submodel)) as Submodel;
  const entry = findEntryNode(next);
  if (!entry) throw new Error('계층 구조에 진입점(EntryNode)이 없습니다.');
  if (!input.name.trim()) throw new Error('이름이 비었습니다.');
  const isGroup = 'group' in input && input.group;
  if (!isGroup && !(input as NodeInput).globalAssetId.trim()) {
    throw new Error('설비의 Asset 주소가 비었습니다.');
  }

  const parent = findByPath(next, parentPath);
  if (!parent) throw new Error(`넣을 자리를 찾지 못했습니다: ${parentPath.join(' → ')}`);

  const holder = parent as unknown as { statements?: SubmodelElement[]; idShort: string };
  holder.statements ??= [];

  if (holder.statements.some((e) => e.idShort === input.name)) {
    throw new Error(`이미 있는 이름입니다: ${input.name}`);
  }
  if (!isGroup) {
    // 🔴 같은 설비를 같은 자리에 두 번 매다는 것을 막는다 — 다른 마디 밑이면 허용한다
    //    (같은 모델이 두 공정에 쓰이는 것은 실제로 있는 일이다)
    const already = childNodes(parent).find(
      (child) =>
        (child as unknown as { globalAssetId?: string }).globalAssetId ===
        (input as NodeInput).globalAssetId,
    );
    if (already) throw new Error(`이미 매달린 설비입니다: ${already.idShort}`);
  }

  const entryName = (entry as unknown as { idShort: string }).idShort;
  const fullParent = [entryName, ...parentPath];
  holder.statements.push(
    isGroup ? buildGroupNode(input.name, iriBase) : buildNode(input as NodeInput, iriBase),
  );
  holder.statements.push(
    buildHasPart(next.id, fullParent, [...fullParent, input.name], iriBase),
  );
  return next;
}

/** 자식 하나를 뺀다 — 관계도 함께 뺀다. 하나만 지우면 짝이 안 맞는 파일이 된다 */
export function removeChild(
  submodel: Submodel,
  name: string,
  parentPath: readonly string[] = [],
): Submodel {
  const next = JSON.parse(JSON.stringify(submodel)) as Submodel;
  const parent = findByPath(next, parentPath);
  if (!parent) throw new Error(`자리를 찾지 못했습니다: ${parentPath.join(' → ')}`);
  const holder = parent as unknown as { statements?: SubmodelElement[] };
  const before = holder.statements?.length ?? 0;
  // 자식과, 그 자식을 second로 가리키는 관계를 함께 뺀다(이름이 아니라 참조로 찾는다)
  holder.statements = (holder.statements ?? []).filter((element) => {
    if (element.idShort === name && element.modelType === 'Entity') return false;
    if (element.modelType === 'RelationshipElement') {
      const keys = (element as unknown as { second?: { keys?: { value?: string }[] } }).second?.keys;
      if (keys && keys[keys.length - 1]?.value === name) return false;
    }
    return true;
  });
  if (holder.statements.length === before) throw new Error(`없는 이름입니다: ${name}`);
  // 🔴 비면 키 자체를 없앤다 — V3.0 스키마는 빈 배열을 허용하지 않는다(PKG-EMPTY-ARRAY).
  //    그룹에서 마지막 자식을 뺄 때 실제로 걸렸다
  if (holder.statements.length === 0) delete holder.statements;
  return next;
}

/** 중첩 트리 한 마디 — 화면과 API가 같은 모양을 쓴다 */
export interface HierarchyTreeNode {
  name: string;
  /** 파일을 가리키면 채워진다. 그룹(중간 마디)은 비어 있다 */
  globalAssetId?: string;
  bulkCount: number;
  children: HierarchyTreeNode[];
}

/** 진입점 아래 전체를 중첩 트리로 읽는다 */
export function hierarchyTree(entity: Entity): HierarchyTreeNode[] {
  return childNodes(entity).map((child) => {
    const raw = child as unknown as {
      idShort?: string;
      globalAssetId?: string;
      statements?: { idShort?: string; value?: string }[];
    };
    const bulk = Number(raw.statements?.find((s) => s.idShort === 'BulkCount')?.value);
    return {
      name: raw.idShort ?? '',
      ...(raw.globalAssetId ? { globalAssetId: raw.globalAssetId } : {}),
      bulkCount: Number.isFinite(bulk) && bulk > 0 ? bulk : 1,
      children: hierarchyTree(child),
    };
  });
}

/**
 * 계층 용어의 ConceptDescription.
 *
 * 🔴 자체 IRI를 semanticId로 쓰면 **대응하는 ConceptDescription이 있어야 한다**(KOSMO-SME-3).
 *    이걸 빠뜨려 공정 뼈대가 태어나자마자 위반 2건으로 시작했다 — 우리 린터가 잡았다.
 *    모양은 지어내지 않고 **골든 파일(설비 20종)이 쓰는 그대로**다:
 *    IEC 61360 데이터명세 + `isCaseOf`로 IDTA 원본을 가리킨다.
 */
const IEC61360 = 'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';

function conceptDescription(idShort: string, ownIri: string, idtaIri: string, dataType: string) {
  return {
    modelType: 'ConceptDescription',
    id: ownIri,
    idShort,
    embeddedDataSpecifications: [
      {
        dataSpecification: {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: IEC61360 }],
        },
        dataSpecificationContent: {
          modelType: 'DataSpecificationIec61360',
          preferredName: [{ language: 'en', text: idShort }],
          dataType,
          definition: [{ language: 'en', text: idShort }],
        },
      },
    ],
    // 이 자체 용어가 어느 IDTA 용어에 해당하는지 — 상호운용의 끈이다
    isCaseOf: [{ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaIri }] }],
  };
}

/** 계층 구조가 쓰는 용어 다섯 — 뼈대와 함께 넣는다 */
export function hierarchyConceptDescriptions(iriBase: string): Record<string, unknown>[] {
  return [
    conceptDescription('EntryNode', `${iriBase}/cd/EntryNode/1/0`, IDTA_HIERARCHY.entryNode, 'STRING'),
    conceptDescription('Node', `${iriBase}/cd/Node/1/0`, IDTA_HIERARCHY.node, 'STRING'),
    conceptDescription('HasPart', `${iriBase}/cd/HasPart/1/0`, IDTA_HIERARCHY.hasPart, 'STRING'),
    conceptDescription('ArcheType', `${iriBase}/cd/ArcheType/1/0`, IDTA_HIERARCHY.archeType, 'STRING'),
    conceptDescription(
      'BulkCount',
      `${iriBase}/cd/BulkCount/1/0`,
      IDTA_HIERARCHY.bulkCount,
      'INTEGER_COUNT',
    ),
  ];
}
