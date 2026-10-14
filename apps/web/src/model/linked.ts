/**
 * Model — linked-file branches of the process view — grafts submodels from other files onto the tree.
 * Split out of src/model.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via model.ts.
 */
import { fill, tr } from '../i18n.js';
import { type AasNode, type ConceptDescription, type Submodel, type TreeNode } from './types.js';
import { buildTree } from './tree.js';

/** Shifts key·depth over and marks everything read-only */
function relocate(node: TreeNode, prefix: string, depthShift: number, packageId: string): TreeNode {
  return {
    ...node,
    key: `${prefix}${node.key}`,
    pointer: `${prefix}${node.pointer}`, // becomes an address that can never collide with a linter finding
    depth: node.depth + depthShift,
    linkedPackageId: packageId,
    children: node.children.map((child) => relocate(child, prefix, depthShift, packageId)),
  };
}

/** One level read from another file — recursive, so a child can be one of these too (company → process → equipment) */
export interface LinkedInfo {
  name: string;
  bulkCount: number;
  /** Process · line (level without a file) — drawn as ▦ in the left tree */
  group?: boolean;
  /** Whether that group is a line level (company → line → process → asset) */
  line?: boolean;
  /** Filled in when that file is open */
  packageId?: string;
  /** If that file is a process (bundle), below it are other files. Otherwise below it are that asset's parts (BoM) */
  composite?: boolean;
  submodels?: Submodel[];
  /** That file's ConceptDescriptions — where findings (KOSMO-CD-*) point */
  concepts?: ConceptDescription[];
  children: LinkedInfo[];
}

/** Reads the child list from a hierarchy submodel (JSON) — same interpretation as the server hierarchy API */
export interface HierarchyChild {
  name: string;
  /** Empty string for a group (intermediate node) */
  globalAssetId: string;
  bulkCount: number;
  children: HierarchyChild[];
}

/** Reads children **with nesting** from a hierarchy submodel (JSON) — same interpretation as the server hierarchy API */
export function childrenOfHierarchy(submodel: Submodel | undefined): HierarchyChild[] {
  const elements = (submodel?.submodelElements ?? []) as Record<string, unknown>[];
  const entry = elements.find((element) => element['modelType'] === 'Entity');
  if (!entry) return [];
  const walk = (holder: Record<string, unknown>): HierarchyChild[] => {
    const statements = (holder['statements'] ?? []) as Record<string, unknown>[];
    return statements
      .filter((element) => element['modelType'] === 'Entity')
      .map((element) => {
        const inner = (element['statements'] ?? []) as Record<string, unknown>[];
        const bulk = Number(inner.find((child) => child['idShort'] === 'BulkCount')?.['value']);
        return {
          name: String(element['idShort'] ?? ''),
          globalAssetId: String(element['globalAssetId'] ?? ''),
          bulkCount: Number.isFinite(bulk) && bulk > 0 ? bulk : 1,
          children: walk(element),
        };
      });
  };
  return walk(entry);
}

/**
 * Branch to insert into the tree — recursively down to "company → process → equipment → per-equipment submodels".
 *
 * Important: this shape does not exist in the file. Per the standard (IDTA-02011) the file holds only address references
 *    (embedding violates KOSMO-AAS-4 — 78 cases measured), and they are grafted **only in the tree people see**.
 *    So every node in this branch is read-only and stamped with linkedPackageId.
 *    If a child is itself a hierarchy file (⚙equipment inside ⚙process), it is grafted the same way.
 */
export function buildLinkedAsset(
  info: LinkedInfo,
  keyPrefix = '/linked',
  /** part: this branch is the asset's parts (BoM) — the case of the top ⚙ row when an asset file is opened directly */
  opts: { part?: boolean } = {},
): TreeNode {
  const key = `${keyPrefix}/${info.name}`;
  // Count without the leading empty segment ('') and 'linked' — it used to count one more, putting only this branch one level deeper (2026-10-14)
  const depth = key.split('/').length - 2; // /linked/a → 1, /linked/a/b → 2
  const root: TreeNode = {
    key,
    label: info.bulkCount > 1 ? fill(tr('{0} ×{1}대'), { 0: info.name, 1: info.bulkCount }) : info.name,
    modelType: 'LinkedAsset',
    pointer: key,
    submodelId: '',
    depth,
    children: [],
    node: { idShort: info.name, modelType: 'LinkedAsset' } as AasNode,
    ...(info.packageId ? { linkedPackageId: info.packageId } : {}),
    ...(info.group ? { linkedGroup: true } : {}),
    ...(info.line ? { linkedLine: true, typeNote: tr('라인') } : {}),
    ...(opts.part ? { linkedPart: true } : {}),
  };
  /**
   * Important: children under an asset file (with packageId) are that asset's **parts** — folded into one "Parts (n)" row.
   *    With several assets in a process the parts rows repeated per asset and grew tall, and being the same LinkedAsset kind
   *    they were confused with assets (user, 2026-09-08). Children under a process (group) or planned asset stay as assets
   */
  const partsFolder = (): TreeNode[] => {
    if (!info.packageId || info.children.length === 0) return [];
    const folderKey = `${key}/__parts`;
    return [
      {
        key: folderKey,
        label: `BOM (${info.children.length})`, // "Parts" → "BOM" — user-specified (2026-09-09)
        modelType: 'LinkedAsset',
        pointer: folderKey,
        submodelId: '',
        depth: depth + 1,
        children: info.children.map((child) => buildLinkedAsset(child, folderKey, { part: true })),
        node: { idShort: tr('부품'), modelType: 'LinkedAsset' } as AasNode,
        linkedPartGroup: true,
      },
    ];
  };
  // Child branches (⚙ · ▦) first, then own submodels — the same reading order as the top level.
  // A group (intermediate node without a file) has no submodels but its children are drawn — the "process" slot in company > process > equipment
  root.children = [
    ...(info.packageId ? partsFolder() : info.children.map((child) => buildLinkedAsset(child, key, opts))),
    ...(info.submodels && info.packageId
      ? buildTree({
          shells: [],
          submodels: info.submodels,
          conceptDescriptions: info.concepts ?? [],
        })
          // Important: include the ConceptDescription group too. Without it, findings pointing to that file's CDs
          //    (KOSMO-CD-5 etc.) have nowhere to go in the tree when clicked — "location cannot be shown" (measured)
          .filter(
            (node) =>
              node.modelType === 'Submodel' || node.modelType === 'ConceptDescriptionGroup',
          )
          .map((node) => relocate(node, key, depth + 1, info.packageId!))
      : []),
  ];
  return root;
}
