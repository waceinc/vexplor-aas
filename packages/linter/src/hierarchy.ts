/**
 * Hierarchy - IDTA 02011 `HierarchicalStructures`.
 *
 * A standard submodel for stating "this consists of those".
 * The golden files (20 equipment types) already use this syntax to describe **parts inside equipment** -
 * roll forming machine -> Uncoiler, RollStandUnit (-> FormingRoll, DriveMotor), CutOffPress.
 *
 * The process unit just **moves this structure one level up**. Same syntax, same submodel.
 *
 *   Welding process (EntryNode) -> roll forming machine (Node), cobot (Node), SPR machine (Node)
 *
 * A child Node does not hold its own details. It **only points to that equipment's Asset** via `globalAssetId`.
 * The equipment details stay in their own files (same spirit as value-sync option A - there is one source of truth).
 */
import { fill, tr, type Entity, type RelationshipElement, type Submodel, type SubmodelElement } from '@aas/core';

/** Defined by IDTA 02011 - not values we made up */
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
 * ArcheType - in which direction this hierarchy is written.
 *  Full     everything is written out (what a process uses)
 *  OneDown  only down to one level below
 *  OneUp    points only to its parent
 */
export type ArcheType = 'Full' | 'OneDown' | 'OneUp';

/** Uses our own IRI (KOSMO) but also attaches the IDTA one as supplemental - same approach as kosmo-first in conflict #5 */
function semanticPair(ownIri: string, idtaIri: string) {
  return {
    semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: ownIri }] },
    supplementalSemanticIds: [
      { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaIri }] },
    ],
  };
}

export interface NodeInput {
  /** Child name - becomes the idShort */
  name: string;
  /** The Asset address of that equipment. This is the only link connecting the two files */
  globalAssetId: string;
  /** Number of units when there are several of the same */
  bulkCount?: number;
}

/** Create one child (Entity Node) */
export function buildNode(input: NodeInput, iriBase: string): Entity {
  const node = {
    idShort: input.name,
    modelType: 'Entity',
    entityType: 'SelfManagedEntity',
    // Important: a SelfManagedEntity must have a globalAssetId (AASd-014)
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

/** One parent -> child relationship */
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
 * Intermediate node (group) - a layer with no file of its own. Something like "welding process" inside a company file.
 *
 * Important: uses CoManagedEntity. A SelfManagedEntity requires a globalAssetId (AASd-014),
 *    but a group has no file to point to - the standard provides CoManaged for exactly this case
 *    (a part managed as part of a parent asset). Same syntax as the nested structure in the golden files.
 */
export function buildGroupNode(name: string, iriBase: string, line = false): Entity {
  return {
    idShort: name,
    modelType: 'Entity',
    entityType: 'CoManagedEntity',
    ...semanticPair(line ? lineSemanticId(iriBase) : `${iriBase}/cd/Node/1/0`, IDTA_HIERARCHY.node),
  } as unknown as Entity;
}

/**
 * Line - the layer between company (plant) and process. Captures 5 levels: company -> line -> process -> equipment -> part
 * (BoM inside the equipment file).
 *
 * The layer kind is recorded via semanticId, not the name - names are chosen by the user (WeldingLine, L1 ...) and cannot be guessed.
 * Our own IRI `…/cd/Line/1/0` is attached together with the IDTA Node as supplemental - to readers of IDTA 02011 it still
 * looks like an ordinary Node. Being our own IRI, it needs a ConceptDescription (KOSMO-SME-3, lineConceptDescription).
 * Lines are placed only at the top (directly under the entry point) - a line under a line blurs the meaning of the layer.
 */
export function lineSemanticId(iriBase: string): string {
  return `${iriBase}/cd/Line/1/0`;
}

/** Is this node a line - judged by the tail of the semanticId (iriBase may differ per file) */
export function isLineNode(entity: Entity): boolean {
  const keys = (entity as unknown as { semanticId?: { keys?: { value?: string }[] } }).semanticId?.keys ?? [];
  return keys.some((key) => typeof key.value === 'string' && key.value.endsWith('/cd/Line/1/0'));
}

/** Walk to a nested Entity by path (names). An empty path means the entry point itself */
export function findByPath(submodel: Submodel, path: readonly string[]): Entity | undefined {
  let current = findEntryNode(submodel);
  for (const name of path) {
    if (!current) return undefined;
    current = childNodes(current).find((child) => child.idShort === name);
  }
  return current;
}

/** Create the entry point (self) - the root of the hierarchy */
export function buildEntryNode(name: string, globalAssetId: string, iriBase: string): Entity {
  return {
    idShort: name,
    modelType: 'Entity',
    entityType: 'SelfManagedEntity',
    globalAssetId,
    ...semanticPair(`${iriBase}/cd/EntryNode/1/0`, IDTA_HIERARCHY.entryNode),
  } as unknown as Entity;
}

/** Find the entry point within the submodel - the first top-level Entity */
export function findEntryNode(submodel: Submodel): Entity | undefined {
  const elements = (submodel.submodelElements ?? []) as SubmodelElement[];
  return elements.find((e) => e.modelType === 'Entity') as Entity | undefined;
}

/** Children of the entry point (Entities only) */
export function childNodes(entry: Entity): Entity[] {
  const statements = (entry as unknown as { statements?: SubmodelElement[] }).statements ?? [];
  return statements.filter((e) => e.modelType === 'Entity') as Entity[];
}

/**
 * Add one child to the hierarchy. **Does not modify the existing one; returns a new submodel** -
 * that is safer because the repository replaces it wholesale (updateIdentifiable).
 */
export function addChild(
  submodel: Submodel,
  input: NodeInput | { name: string; group: true; line?: boolean },
  iriBase: string,
  /** Which node to insert under - the name path from the entry point. Empty means the top level */
  parentPath: readonly string[] = [],
): Submodel {
  const next = JSON.parse(JSON.stringify(submodel)) as Submodel;
  const entry = findEntryNode(next);
  if (!entry) throw new Error(tr('계층 구조에 진입점(EntryNode)이 없습니다.'));
  if (!input.name.trim()) throw new Error(tr('이름이 비었습니다.'));
  const isGroup = 'group' in input && input.group;
  const isLine = isGroup && 'line' in input && input.line === true;
  if (!isGroup && !(input as NodeInput).globalAssetId.trim()) {
    throw new Error(tr('설비의 Asset 주소가 비었습니다.'));
  }

  const parent = findByPath(next, parentPath);
  if (!parent) throw new Error(fill(tr('넣을 자리를 찾지 못했습니다: {0}'), { 0: parentPath.join(' → ') }));
  if (isLine && parentPath.length > 0) throw new Error(tr('라인은 맨 위(회사 바로 밑)에만 둡니다.'));

  const holder = parent as unknown as { statements?: SubmodelElement[]; idShort: string };
  holder.statements ??= [];

  if (holder.statements.some((e) => e.idShort === input.name)) {
    throw new Error(fill(tr('이미 있는 이름입니다: {0}'), { 0: input.name }));
  }
  if (!isGroup) {
    // Important: prevents attaching the same equipment twice at the same position - allowed under a different node
    //    (the same model being used in two processes does happen in practice)
    const already = childNodes(parent).find(
      (child) =>
        (child as unknown as { globalAssetId?: string }).globalAssetId ===
        (input as NodeInput).globalAssetId,
    );
    if (already) throw new Error(fill(tr('이미 매달린 설비입니다: {0}'), { 0: already.idShort }));
  }

  const entryName = (entry as unknown as { idShort: string }).idShort;
  const fullParent = [entryName, ...parentPath];
  holder.statements.push(
    isGroup ? buildGroupNode(input.name, iriBase, isLine) : buildNode(input as NodeInput, iriBase),
  );
  holder.statements.push(
    buildHasPart(next.id, fullParent, [...fullParent, input.name], iriBase),
  );
  return next;
}

/** Remove one child - its relationship is removed too. Removing only one leaves a file with mismatched pairs */
export function removeChild(
  submodel: Submodel,
  name: string,
  parentPath: readonly string[] = [],
): Submodel {
  const next = JSON.parse(JSON.stringify(submodel)) as Submodel;
  const parent = findByPath(next, parentPath);
  if (!parent) throw new Error(fill(tr('자리를 찾지 못했습니다: {0}'), { 0: parentPath.join(' → ') }));
  const holder = parent as unknown as { statements?: SubmodelElement[] };
  const before = holder.statements?.length ?? 0;
  // Remove the child together with the relationship whose second points to it (found by reference, not by name)
  holder.statements = (holder.statements ?? []).filter((element) => {
    if (element.idShort === name && element.modelType === 'Entity') return false;
    if (element.modelType === 'RelationshipElement') {
      const keys = (element as unknown as { second?: { keys?: { value?: string }[] } }).second?.keys;
      if (keys && keys[keys.length - 1]?.value === name) return false;
    }
    return true;
  });
  if (holder.statements.length === before) throw new Error(fill(tr('없는 이름입니다: {0}'), { 0: name }));
  // Important: if empty, drop the key itself - the V3.0 schema does not allow empty arrays (PKG-EMPTY-ARRAY).
  //    This actually bit us when removing the last child from a group
  if (holder.statements.length === 0) delete holder.statements;
  return next;
}

/** One node of the nested tree - the UI and API use the same shape */
export interface HierarchyTreeNode {
  name: string;
  /** Filled when it points to a file. Empty for a group (intermediate node) */
  globalAssetId?: string;
  bulkCount: number;
  /** true for a line layer (judged by semanticId). Ordinary layers such as processes are omitted */
  line?: true;
  children: HierarchyTreeNode[];
}

/** Read everything under the entry point as a nested tree */
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
      ...(isLineNode(child) ? { line: true as const } : {}),
      children: hierarchyTree(child),
    };
  });
}

/**
 * ConceptDescriptions for the hierarchy terms.
 *
 * Important: when our own IRI is used as a semanticId, **a matching ConceptDescription must exist** (KOSMO-SME-3).
 *    Missing this made the process scaffold start life with 2 violations - our own linter caught it.
 *    The shape is not invented; it is **exactly what the golden files (20 equipment types) use**:
 *    an IEC 61360 data specification + `isCaseOf` pointing to the IDTA original.
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
    // Which IDTA term this term of ours corresponds to - the link for interoperability
    isCaseOf: [{ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaIri }] }],
  };
}

/** Line term - added to the file when a line is first created if not already present (not added to the scaffold: it would be an unused term) */
export function lineConceptDescription(iriBase: string): Record<string, unknown> {
  return conceptDescription('Line', lineSemanticId(iriBase), IDTA_HIERARCHY.node, 'STRING');
}

/** The five terms used by the hierarchy - added together with the scaffold */
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
