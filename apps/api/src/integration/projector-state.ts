/**
 * Digests the projector compares (design §13.4) — one per equipment master row, and one per BOM, maintenance plan
 * set and document index of a package. Pure reads of the model; the projector decides what becomes an event.
 */
import { createHash } from 'node:crypto';
import { EVENT_TYPES, type AssetJoin } from '@aas/core';
import { canonicalJson } from './ids.js';
import { readBom } from './exports/bom.js';
import { EQUIPMENT_V1_COLUMNS } from './exports/columns.js';
import { cellText } from './exports/csv.js';
import { createFileResolver, readDocuments } from './exports/documents.js';
import { equipmentRow, projectPackageEquipment, type EquipmentItem } from './exports/equipment.js';
import { isProcessFile, readHierarchy, type LocationEntry } from './exports/location.js';
import { readMaintenancePlans } from './exports/maintenance.js';
import type { IntegrationAasStore } from './exports/store.js';

export type Part = 'bom' | 'maintenance' | 'documents';
export const PART_TYPES: Record<Part, string> = {
  bom: EVENT_TYPES.equipmentBomChanged,
  maintenance: EVENT_TYPES.equipmentMaintenanceChanged,
  documents: EVENT_TYPES.equipmentDocumentsChanged,
};

export interface MasterDigest {
  hash: string;
  values: Record<string, string>;
  asset: AssetJoin;
}

export interface PartDigest {
  hash: string;
  asset: AssetJoin;
}

export interface ProjectorState {
  master: Record<string, MasterDigest>;
  parts: Partial<Record<Part, PartDigest>>;
  /** Process files only: assets the hierarchy places — their location changes with this file */
  placed?: string[];
  /**
   * Package owner when last projected (null = shared). Kept so the "removed" events of a deleted private package still
   * carry its workspace — after the deletion nobody can look it up any more (review H1).
   */
  owner?: string | null;
}

const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/** Column values of an equipment item — the digest input. `revision` changes with every edit, so it is left out */
export function masterValues(item: EquipmentItem): Record<string, string> {
  const row = equipmentRow(item);
  const out: Record<string, string> = {};
  for (const column of EQUIPMENT_V1_COLUMNS) if (column !== 'revision') out[column] = cellText(row[column]);
  return out;
}

/** Current digests of an existing package; `asset` = its join block */
export async function computeState(
  store: IntegrationAasStore,
  asset: AssetJoin,
  packageId: string,
  locations: Map<string, LocationEntry[]>,
): Promise<ProjectorState> {
  const environment = await store.getEnvironment(packageId);
  const { items } = await projectPackageEquipment(store, packageId, locations, { lang: 'ko', includeTypes: false, trace: false }, environment);
  const master: Record<string, MasterDigest> = {};
  for (const item of items) {
    const values = masterValues(item);
    const location = (locations.get(item.key) ?? []).filter((entry) => entry.packageId !== packageId);
    master[item.key] = {
      hash: sha256(values),
      values,
      asset:
        asset.globalAssetId === item.key
          ? asset
          : {
              globalAssetId: item.key,
              aasId: item.aasId,
              packageId,
              assetKind: item.assetKind as AssetJoin['assetKind'],
              serialNumber: item.nameplate.serialNumber,
              specificAssetIds: item.specificAssetIds,
              externalRefs: item.externalRefs,
              path: location[0]?.path ?? [],
              isa95: location[0]?.isa95 ?? null,
              ...(location.length > 1 ? { pathAmbiguous: true as const } : {}),
            },
    };
  }
  const refs = (await store.getExternalRefs(packageId))?.value;
  // Path-only links: the digest must not change when AAS_PUBLIC_URL does
  const resolver = createFileResolver(packageId, await store.packageFiles(packageId));
  const bom = readBom(environment, refs);
  const plans = readMaintenancePlans(environment, 'ko', 0, resolver);
  const documents = readDocuments(environment, 'ko', resolver);
  const parts: ProjectorState['parts'] = {};
  if (bom.ok) parts.bom = { hash: sha256(bom.rows), asset };
  if (plans.length > 0) parts.maintenance = { hash: sha256(plans.map((plan) => plan.contentHash)), asset };
  if (documents.length > 0) parts.documents = { hash: sha256(documents), asset };
  const placed = isProcessFile(environment)
    ? [...new Set((readHierarchy(environment)?.nodes ?? []).filter((node) => node.depth > 0 && node.globalAssetId).map((node) => node.globalAssetId!))].sort()
    : undefined;
  return { master, parts, ...(placed ? { placed } : {}) };
}
