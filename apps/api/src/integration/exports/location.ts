/**
 * Hierarchy reading and plant location (design §2.2 `path` / `isa95`, D19, §4.4 hierarchy export).
 *
 * A **process file** (company / line / process) is a package with a `HierarchicalStructures` submodel and no nameplate —
 * the scaffold creates organisational files exactly like that (linter scaffold.ts). Its nodes point at equipment through
 * `globalAssetId`; that pointer is the only join. An equipment file's own `HierarchicalStructures` is its BOM, not a
 * location, so it never feeds `path`.
 *
 * ISA-95 level per node (D19): entry = Enterprise, line node = Area, other group = WorkCenter, node with a
 * `globalAssetId` = WorkUnit — unless the process file's package config overrides the node path
 * (`isa95.levels["Entry/Line-A"] = "WorkCenter"`). `isa95.site` fills the site when no node is a Site.
 */
import { fill, tr, type Entity, type Environment, type Isa95Level, type Isa95Path, type PackageIntegrationConfig } from '@aas/core';
import { HIERARCHY_SUBMODEL_ID_SHORT, isLineNode } from '@aas/linter';
import { asArray, findSubmodel, idShortOf, modelTypeOf, submodelsOf, shellsOf, textOf, type Json } from './elements.js';
import { nameplateSubmodels } from './nameplate.js';

export interface HierarchyNode {
  /** Names from the entry node down to this node (entry included) */
  path: string[];
  name: string;
  globalAssetId?: string;
  entityType?: string;
  /** BulkCount statement, default 1 */
  bulkCount: number;
  line: boolean;
  /** 0 = entry node */
  depth: number;
  raw: Json;
  children: HierarchyNode[];
}

export interface Hierarchy {
  submodel: Json;
  entry: HierarchyNode;
  /** Every node, entry first, depth first */
  nodes: HierarchyNode[];
}

function entityChildren(entity: Json): Json[] {
  return asArray(entity['statements']).filter((statement) => modelTypeOf(statement) === 'Entity');
}

function bulkCountOf(entity: Json): number {
  const statement = asArray(entity['statements']).find((s) => idShortOf(s) === 'BulkCount');
  const value = Number(textOf(statement, 'en'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function toNode(entity: Json, parentPath: readonly string[], depth: number): HierarchyNode {
  const name = idShortOf(entity) ?? '';
  const path = [...parentPath, name];
  const globalAssetId = typeof entity['globalAssetId'] === 'string' && entity['globalAssetId'] !== '' ? entity['globalAssetId'] : undefined;
  const entityType = typeof entity['entityType'] === 'string' ? entity['entityType'] : undefined;
  return {
    path,
    name,
    ...(globalAssetId ? { globalAssetId } : {}),
    ...(entityType ? { entityType } : {}),
    bulkCount: bulkCountOf(entity),
    line: isLineNode(entity as unknown as Entity),
    depth,
    raw: entity,
    children: entityChildren(entity).map((child) => toNode(child, path, depth + 1)),
  };
}

/** The `HierarchicalStructures` of the package (its first shell's submodels), or undefined */
export function readHierarchy(environment: Environment): Hierarchy | undefined {
  const submodel = findSubmodel(submodelsOf(environment, shellsOf(environment)[0]), [HIERARCHY_SUBMODEL_ID_SHORT], /HierarchicalStructures/);
  if (!submodel) return undefined;
  const entryRaw = asArray(submodel['submodelElements']).find((element) => modelTypeOf(element) === 'Entity');
  if (!entryRaw) return undefined;
  const entry = toNode(entryRaw, [], 0);
  const nodes: HierarchyNode[] = [];
  const visit = (node: HierarchyNode): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(entry);
  return { submodel, entry, nodes };
}

/** Organisational file: a hierarchy and no nameplate (see the file header) */
export function isProcessFile(environment: Environment): boolean {
  return readHierarchy(environment) !== undefined && nameplateSubmodels(environment, shellsOf(environment)[0]).nameplate === undefined;
}

export function defaultLevel(node: HierarchyNode): Isa95Level {
  if (node.depth === 0) return 'Enterprise';
  if (node.globalAssetId !== undefined) return 'WorkUnit';
  return node.line ? 'Area' : 'WorkCenter';
}

export function nodeKey(node: HierarchyNode): string {
  return node.path.join('/');
}

export function levelOf(node: HierarchyNode, config: PackageIntegrationConfig | null): Isa95Level {
  return config?.isa95.levels[nodeKey(node)] ?? defaultLevel(node);
}

const FIELD: Record<Isa95Level, keyof Isa95Path> = {
  Enterprise: 'enterprise',
  Site: 'site',
  Area: 'area',
  WorkCenter: 'workCenter',
  WorkUnit: 'workUnit',
};

/** ISA-95 names along a node chain — the deepest node of a level wins; `isa95.site` fills a missing site */
export function isa95Of(chain: readonly HierarchyNode[], config: PackageIntegrationConfig | null): Isa95Path {
  const out: Isa95Path = {};
  for (const node of chain) out[FIELD[levelOf(node, config)]] = node.name;
  if (out.site === undefined && config?.isa95.site) out.site = config.isa95.site;
  return out;
}

/** Override keys of the config that name no node of this hierarchy (renamed or removed nodes) */
export function staleOverrides(hierarchy: Hierarchy | undefined, config: PackageIntegrationConfig | null): string[] {
  const keys = Object.keys(config?.isa95.levels ?? {});
  const present = new Set(hierarchy?.nodes.map(nodeKey) ?? []);
  return keys
    .filter((key) => !present.has(key))
    .sort()
    .map((key) => fill(tr('ISA-95 수준 지정의 노드 경로가 계층에 없습니다: {0}'), { 0: key }));
}

/** Where one asset appears in one process file */
export interface LocationEntry {
  packageId: string;
  path: string[];
  isa95: Isa95Path;
}

export interface ProcessFile {
  packageId: string;
  environment: Environment;
  config: PackageIntegrationConfig | null;
}

/** globalAssetId → appearances, process files in ascending package id order (the caller sorts `files`) */
export function buildLocationIndex(files: readonly ProcessFile[]): Map<string, LocationEntry[]> {
  const index = new Map<string, LocationEntry[]>();
  for (const file of files) {
    const hierarchy = readHierarchy(file.environment);
    if (!hierarchy) continue;
    const visit = (node: HierarchyNode, chain: HierarchyNode[]): void => {
      const here = [...chain, node];
      if (node.depth > 0 && node.globalAssetId) {
        const entries = index.get(node.globalAssetId) ?? [];
        // One appearance per file — the first (depth-first, model order) is the location
        if (!entries.some((entry) => entry.packageId === file.packageId)) {
          entries.push({ packageId: file.packageId, path: node.path, isa95: isa95Of(here, file.config) });
          index.set(node.globalAssetId, entries);
        }
      }
      for (const childNode of node.children) visit(childNode, here);
    };
    visit(hierarchy.entry, []);
  }
  return index;
}
