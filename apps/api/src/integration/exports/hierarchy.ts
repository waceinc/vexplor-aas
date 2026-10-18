/**
 * Plant hierarchy export `kr.vexplor.aas.hierarchy.v1` for MES master data (design §4.4, D19).
 *
 * A flat list with `id` = the `/`-joined node path and `parentId`. A node with `BulkCount > 1` that points at one
 * `globalAssetId` gets an INT-4 warning and stays **one** row — n machines cannot share one asset id, and inventing
 * n rows would invent n identities. Equipment details (aasId, serial number) come from the package that holds the asset.
 */
import { fill, tr, type Isa95Level, type PackageIntegrationConfig, type SpecificAssetIdPair } from '@aas/core';
import type { AasStore } from '@aas/store';
import { sortedChildren } from './bom.js';
import { shellsOf, specificAssetIdsOf, assetInformationOf } from './elements.js';
import { isProcessFile, levelOf, nodeKey, readHierarchy, staleOverrides, type HierarchyNode } from './location.js';
import { serialNumberOf } from './nameplate.js';
import { readinessMessage } from './readiness.js';
import { allPackages } from './store.js';
import type { Environment } from '@aas/core';

export interface AssetDirectoryEntry {
  packageId: string;
  aasId: string | null;
  serialNumber: string | null;
  specificAssetIds: SpecificAssetIdPair[];
}

/** globalAssetId → packages whose first shell carries it, ascending package id */
export async function buildAssetDirectory(store: AasStore): Promise<Map<string, AssetDirectoryEntry[]>> {
  const directory = new Map<string, AssetDirectoryEntry[]>();
  for (const record of await allPackages(store)) {
    const environment = await store.getEnvironment(record.id);
    const shell = shellsOf(environment)[0];
    const globalAssetId = assetInformationOf(shell)['globalAssetId'];
    if (typeof globalAssetId !== 'string' || globalAssetId === '') continue;
    const entries = directory.get(globalAssetId) ?? [];
    entries.push({
      packageId: record.id,
      aasId: typeof shell?.['id'] === 'string' ? shell['id'] : null,
      serialNumber: serialNumberOf(environment, shell),
      specificAssetIds: specificAssetIdsOf(shell),
    });
    directory.set(globalAssetId, entries);
  }
  return directory;
}

export interface HierarchyItem {
  id: string;
  parentId: string | null;
  equipmentLevel: Isa95Level;
  name: string;
  globalAssetId: string | null;
  aasId: string | null;
  packageId: string | null;
  serialNumber: string | null;
  quantity: number;
  specificAssetIds: SpecificAssetIdPair[];
  warnings: string[];
}

export function readHierarchyItems(
  environment: Environment,
  config: PackageIntegrationConfig | null,
  directory: Map<string, AssetDirectoryEntry[]>,
  selfPackageId: string,
): { items: HierarchyItem[]; warnings: string[] } | undefined {
  const hierarchy = readHierarchy(environment);
  // An equipment file's hierarchy is its BOM tree: a quantity there is a part count, not n machines sharing one asset
  // id, so INT-4 applies to company / line / process files only — the same rule as the readiness check (review D2)
  const processFile = isProcessFile(environment);
  if (!hierarchy) return undefined;
  const items: HierarchyItem[] = [];
  const visit = (node: HierarchyNode, parent: HierarchyNode | undefined): void => {
    const warnings: string[] = [];
    const level = levelOf(node, config);
    const globalAssetId = node.globalAssetId ?? null;
    // The entry node is this file itself; every other node is held by another file
    const holders =
      globalAssetId === null
        ? []
        : (directory.get(globalAssetId) ?? []).filter((entry) => (node.depth === 0) === (entry.packageId === selfPackageId));
    const holder = holders[0];
    if (processFile && node.depth > 0 && globalAssetId !== null && node.bulkCount > 1) {
      warnings.push(`${readinessMessage('INT-4')} (${nodeKey(node)} ×${node.bulkCount})`);
    }
    if (level === 'WorkUnit' && globalAssetId === null) warnings.push(tr('WorkUnit 노드에 globalAssetId가 없습니다.'));
    if (node.depth > 0 && globalAssetId !== null && !holder) warnings.push(tr('이 자산의 파일이 서버에 없습니다.'));
    if (holders.length > 1) {
      warnings.push(fill(tr('같은 자산의 파일이 {0}개입니다 — 패키지 id가 가장 낮은 파일을 씁니다.'), { 0: holders.length }));
    }
    items.push({
      id: nodeKey(node),
      parentId: parent ? nodeKey(parent) : null,
      equipmentLevel: level,
      name: node.name,
      globalAssetId,
      aasId: holder?.aasId ?? null,
      packageId: holder?.packageId ?? null,
      serialNumber: holder?.serialNumber ?? null,
      quantity: node.bulkCount,
      specificAssetIds: holder?.specificAssetIds ?? [],
      warnings,
    });
    for (const childNode of sortedChildren(node)) visit(childNode, node);
  };
  visit(hierarchy.entry, undefined);
  return { items, warnings: staleOverrides(hierarchy, config) };
}

export function hierarchyRow(item: HierarchyItem): Record<string, string | number | boolean | null | string[]> {
  return { ...item, specificAssetIds: item.specificAssetIds.map((pair) => `${pair.name}=${pair.value}`) };
}
