/**
 * File summary totals — the composition as people see it in a process (group) file, and content totals including linked equipment files.
 * Split out of MiddlePane (2026-10-14) — the calculations are unchanged from before the move.
 */
import type { HierarchyNode, HierarchyView } from '../api.js';
import { countElements, type ConceptDescription, type LinkedInfo, type Submodel } from '../model.js';

export function summaryTotals(
  submodels: readonly Submodel[],
  concepts: readonly ConceptDescription[],
  linked: readonly LinkedInfo[],
): { submodels: number; elements: number; concepts: number; unopened: number } {
  let subCount = submodels.length;
  let elementCount = countElements(submodels);
  let conceptCount = concepts.length;
  let unopened = 0;
  const walk = (nodes: readonly LinkedInfo[]): void => {
    for (const node of nodes) {
      if (node.submodels) {
        subCount += node.submodels.length;
        elementCount += countElements(node.submodels);
        conceptCount += node.concepts?.length ?? 0;
        // Parts (BoM) under an open equipment are already counted inside that equipment file — they are not
        // separate files. A roll-forming machine's 3 parts used to be counted as "3 unopened equipment" (verified 2026-09-30).
        // But if the open file is a group (process), what lies below are other files, so keep counting
        if (!node.composite) continue;
      } else if (node.children.length === 0 && !node.group) {
        unopened += 1; // File not open, contents unknown — report it rather than hide it
      }
      walk(node.children);
    }
  };
  walk(linked);
  return { submodels: subCount, elements: elementCount, concepts: conceptCount, unopened };
}

/** Count by the composition people see — lines · groups (process/level) and equipment (references), summing unit quantities */
export function summaryComposition(hierarchy: HierarchyView): { lines: number; groups: number; assets: number; units: number } {
  let lines = 0;
  let groups = 0;
  let assets = 0;
  let units = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      if (node.globalAssetId === '' && node.line) lines += 1;
      else if (node.globalAssetId === '') groups += 1;
      else {
        assets += 1;
        units += node.bulkCount;
      }
      walk(node.children);
    }
  };
  walk(hierarchy.children);
  return { lines, groups, assets, units };
}
