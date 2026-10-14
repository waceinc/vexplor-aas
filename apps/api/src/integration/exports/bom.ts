/**
 * BOM export `vexplor.bom/1` — the equipment file's `HierarchicalStructures` flattened to parent–child rows
 * (design §4.4, ERP §2.2).
 *
 * - The root must be the shell's own asset (INT-2): a BOM whose entry node points at another asset would load under a
 *   wrong ERP header, so the export refuses instead (422 `BomRootMismatch`).
 * - `quantity` = the child's `BulkCount`, default 1, **per parent** (not cumulative).
 * - Material numbers come only from external refs (subject `bomChild`, type `material`). Unmapped rows are kept with
 *   `mapped: false` — never dropped, never filled with a guess.
 * - Siblings are ordered by (globalAssetId, name), so reordering entities in the editor does not reorder rows (E-10).
 */
import type { Environment, PublicExternalRef } from '@aas/core';
import type { ExternalRefsDoc } from '@aas/store';
import { assetInformationOf, shellsOf } from './elements.js';
import { publicRefsOf } from './join.js';
import { isProcessFile, readHierarchy, type HierarchyNode } from './location.js';

export interface BomRow {
  rootKey: string;
  parentPath: string;
  childPath: string;
  childName: string;
  childGlobalAssetId: string | null;
  quantity: number;
  level: number;
  entityType: string | null;
  erpMaterial: Omit<PublicExternalRef, 'type'>[];
  mapped: boolean;
}

export type BomRead =
  | { ok: true; rootKey: string; rows: BomRow[] }
  | { ok: false; reason: 'no-hierarchy' }
  | { ok: false; reason: 'no-asset' }
  | { ok: false; reason: 'process-file' }
  | { ok: false; reason: 'root-mismatch'; entryGlobalAssetId: string | null; shellGlobalAssetId: string };

export function shellGlobalAssetId(environment: Environment): string | null {
  const value = assetInformationOf(shellsOf(environment)[0])['globalAssetId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function sortedChildren(node: HierarchyNode): HierarchyNode[] {
  return [...node.children].sort(
    (a, b) => (a.globalAssetId ?? '').localeCompare(b.globalAssetId ?? '') || a.name.localeCompare(b.name),
  );
}

export function readBom(environment: Environment, refs: ExternalRefsDoc | undefined): BomRead {
  const hierarchy = readHierarchy(environment);
  if (!hierarchy) return { ok: false, reason: 'no-hierarchy' };
  // A company / process hierarchy is plant structure, not a bill of materials (hierarchy export)
  if (isProcessFile(environment)) return { ok: false, reason: 'process-file' };
  const rootKey = shellGlobalAssetId(environment);
  if (rootKey === null) return { ok: false, reason: 'no-asset' };
  const entryId = hierarchy.entry.globalAssetId ?? null;
  if (entryId !== rootKey) return { ok: false, reason: 'root-mismatch', entryGlobalAssetId: entryId, shellGlobalAssetId: rootKey };

  const rows: BomRow[] = [];
  const visit = (parent: HierarchyNode): void => {
    for (const node of sortedChildren(parent)) {
      const childGlobalAssetId = node.globalAssetId ?? null;
      const erpMaterial =
        childGlobalAssetId === null
          ? []
          : publicRefsOf(refs, (subject) => subject.kind === 'bomChild' && subject.globalAssetId === childGlobalAssetId)
              .filter((ref) => ref.type === 'material')
              .map((ref) => ({ system: ref.system, id: ref.id }));
      rows.push({
        rootKey,
        parentPath: parent.path.join('/'),
        childPath: node.path.join('/'),
        childName: node.name,
        childGlobalAssetId,
        quantity: node.bulkCount,
        level: node.depth,
        entityType: node.entityType ?? null,
        erpMaterial,
        mapped: erpMaterial.length > 0,
      });
      visit(node);
    }
  };
  visit(hierarchy.entry);
  return { ok: true, rootKey, rows };
}

export function bomRow(row: BomRow): Record<string, string | number | boolean | null | string[]> {
  return { ...row, erpMaterial: row.erpMaterial.map((ref) => `${ref.system}|${ref.id}`) };
}
