/**
 * Model — tree building · expanded rows · search · expanding to a finding · value display · element counting.
 * Split out of src/model.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via model.ts.
 */
import { type AasNode, type Environment, type Submodel, type TreeNode } from './types.js';

/** Fields holding children — must follow the same rule as traverse in @aas/core */
function childrenOf(node: AasNode): { field: string; items: AasNode[] } | undefined {
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(node.value) ? { field: 'value', items: node.value as AasNode[] } : undefined;
  }
  if (node.modelType === 'Entity') {
    return node.statements ? { field: 'statements', items: node.statements } : undefined;
  }
  if (node.modelType === 'AnnotatedRelationshipElement') {
    return node.annotations ? { field: 'annotations', items: node.annotations } : undefined;
  }
  return undefined;
}

/**
 * Builds a tree from the whole Environment — all three: AAS · Submodel · ConceptDescription.
 *
 * When only submodels were drawn, **findings had nowhere to go.** Of the measured defects, `KOSMO-AAS-*` attach to the AAS
 * and `KOSMO-CD-*` to ConceptDescriptions, but with no such nodes in the tree, clicking them opened nothing
 * (only seen on screen — "4 violations" while the tree showed just 2 badges).
 *
 * ConceptDescriptions reach 137, so they are **folded under a group node.** This keeps the tree clean
 * while still giving findings a place to land.
 *
 * List order is the Environment array order (the store preserves it by ordinal) — that is what keeps pointers aligned with the linter.
 */
export const CONCEPT_GROUP_KEY = '/conceptDescriptions';

export function buildTree(environment: Environment): TreeNode[] {
  const roots: TreeNode[] = [];

  environment.shells.forEach((shell, index) => {
    const pointer = `/assetAdministrationShells/${index}`;
    const node: TreeNode = {
      key: pointer,
      label: shell.idShort ?? shell.id,
      modelType: 'AssetAdministrationShell',
      pointer,
      submodelId: '',
      depth: 0,
      children: [],
      node: shell,
    };
    if (shell.assetInformation) {
      node.children.push({
        key: `${pointer}/assetInformation`,
        label: 'AssetInformation',
        modelType: 'AssetInformation',
        pointer: `${pointer}/assetInformation`,
        submodelId: '',
        depth: 1,
        children: [],
        node: shell.assetInformation as AasNode,
      });
    }
    roots.push(node);
  });

  environment.submodels.forEach((submodel, index) => {
    const pointer = `/submodels/${index}`;
    const root: TreeNode = {
      key: pointer,
      label: submodel.idShort ?? submodel.id,
      modelType: 'Submodel',
      pointer,
      submodelId: submodel.id,
      depth: 0,
      children: [],
      node: submodel,
    };
    root.children = buildElements(
      submodel.submodelElements ?? [],
      `${pointer}/submodelElements`,
      undefined,
      submodel.id,
      1,
      undefined,
    );
    roots.push(root);
  });

  if (environment.conceptDescriptions.length > 0) {
    roots.push({
      key: CONCEPT_GROUP_KEY,
      // Important: use the spec terms as is (user, 2026-09-01). Translating them into Korean breaks matching against spec documents and Validator
      //    reports. What each one is, the kind label and the property pane explain.
      label: `ConceptDescriptions (${environment.conceptDescriptions.length})`,
      modelType: 'ConceptDescriptionGroup',
      pointer: CONCEPT_GROUP_KEY,
      submodelId: '',
      depth: 0,
      children: environment.conceptDescriptions.map((cd, index) => ({
        key: `${CONCEPT_GROUP_KEY}/${index}`,
        label: cd.idShort ?? cd.id,
        modelType: 'ConceptDescription',
        pointer: `${CONCEPT_GROUP_KEY}/${index}`,
        submodelId: '',
        depth: 1,
        children: [],
        node: cd,
      })),
      node: { modelType: 'ConceptDescriptionGroup' },
    });
  }

  return roots;
}

function buildElements(
  items: readonly AasNode[],
  pointerBase: string,
  parent: AasNode | undefined,
  submodelId: string,
  depth: number,
  parentPath: string | undefined,
): TreeNode[] {
  return items.map((node, index) => {
    const pointer = `${pointerBase}/${index}`;
    // Children of a SubmodelElementList are addressed by index per the spec (they can be anonymous)
    const inList = parent?.modelType === 'SubmodelElementList';
    const segment = inList ? `[${index}]` : (node.idShort ?? `[${index}]`);
    const idShortPath = inList
      ? `${parentPath ?? ''}${segment}`
      : parentPath
        ? `${parentPath}.${segment}`
        : segment;

    const tree: TreeNode = {
      key: pointer,
      label: node.idShort ?? `[${index}]`,
      modelType: node.modelType,
      pointer,
      idShortPath,
      submodelId,
      depth,
      children: [],
      node,
    };

    const children = childrenOf(node);
    if (children) {
      tree.children = buildElements(
        children.items,
        `${pointer}/${children.field}`,
        node,
        submodelId,
        depth + 1,
        idShortPath,
      );
    }
    return tree;
  });
}

/** Lists only expanded rows, top-down. Virtual scrolling windows this array */
export function flatten(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.key)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * Search in the tree.
 *
 * A single file has over 200 elements. Skimming by eye is impractical, so **results are filtered** —
 * only matching nodes and **the path to them (ancestors)** are kept. Ancestors are kept because
 * when the same name exists in several submodels you need to know which one it is.
 *
 * What is searched: name (idShort) · kind · value · semanticId. Case-insensitive.
 */
export function searchTree(
  roots: readonly TreeNode[],
  query: string,
): { rows: TreeNode[]; matched: Set<string> } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { rows: [], matched: new Set() };

  const matched = new Set<string>();
  const keep = new Set<string>();

  const hits = (node: TreeNode): boolean => {
    if (node.label.toLowerCase().includes(needle)) return true;
    if (node.modelType.toLowerCase().includes(needle)) return true;
    if (displayValue(node.node).toLowerCase().includes(needle)) return true;
    const semantic = node.node['semanticId'] as { keys?: { value: string }[] } | undefined;
    const id = semantic?.keys?.[0]?.value;
    if (id && id.toLowerCase().includes(needle)) return true;
    // Submodels and CDs must be findable by id too — findings refer to them by id
    const own = node.node['id'];
    return typeof own === 'string' && own.toLowerCase().includes(needle);
  };

  /** If something below matched, I stay too (do not break the path) */
  const walk = (node: TreeNode): boolean => {
    const self = hits(node);
    if (self) matched.add(node.key);
    let below = false;
    for (const child of node.children) below = walk(child) || below;
    if (self || below) keep.add(node.key);
    return self || below;
  };
  for (const root of roots) walk(root);

  const rows: TreeNode[] = [];
  const collect = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (!keep.has(node.key)) continue;
      rows.push(node);
      // Do not expand the children of a matched node — the result would get long again
      if (!matched.has(node.key)) collect(node.children);
    }
  };
  collect(roots);

  return { rows, matched };
}

/**
 * The node a finding points to, plus the parents on the way there.
 *
 * Instead of guessing with a string rule (numeric segment means node), **look it up in the actual tree** —
 * some nodes, such as the AAS `assetInformation` or the ConceptDescription group, do not end in a number,
 * so a rule-based guess would never open those findings.
 */
export interface RevealPath {
  /** Nodes to expand (including the target itself) */
  keys: string[];
  /** Node to select. undefined if not in the tree */
  target?: string;
}

export function revealPath(roots: readonly TreeNode[], pointer: string): RevealPath {
  const chain: TreeNode[] = [];

  const walk = (nodes: readonly TreeNode[], parents: TreeNode[]): boolean => {
    for (const node of nodes) {
      const covers = pointer === node.pointer || pointer.startsWith(`${node.pointer}/`);
      if (!covers) continue;
      const here = [...parents, node];
      // A deeper node, if any, owns it (longest overlapping node)
      if (!walk(node.children, here)) chain.push(...here);
      return true;
    }
    return false;
  };

  walk(roots, []);
  const keys = chain.map((node) => node.pointer);
  const target = keys[keys.length - 1];
  return target === undefined ? { keys } : { keys, target };
}

/** Whether the value is editable — the UI opens input only for kinds editable via $value */
export const EDITABLE_VALUE_TYPES = new Set(['Property', 'File', 'Blob', 'MultiLanguageProperty', 'Range']);

export function displayValue(node: AasNode): string {
  if (node.modelType === 'MultiLanguageProperty') {
    const list = (node.value as { language: string; text: string }[] | undefined) ?? [];
    return list.map((s) => `${s.language}: ${s.text}`).join(' / ');
  }
  if (node.modelType === 'Range') {
    return `${String(node['min'] ?? '')} ~ ${String(node['max'] ?? '')}`;
  }
  if (typeof node.value === 'string') return node.value;
  return '';
}

/** Total element count — used in the summary tile. Expanded row count is UI state and says nothing about file size */
export function countElements(submodels: readonly Submodel[]): number {
  let total = 0;
  const walk = (nodes: readonly AasNode[]): void => {
    for (const node of nodes) {
      total += 1;
      const children = childrenOf(node);
      if (children) walk(children.items);
    }
  };
  for (const submodel of submodels) walk(submodel.submodelElements ?? []);
  return total;
}
