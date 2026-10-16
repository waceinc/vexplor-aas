/**
 * Equipment master export `vexplor.equipmentMaster/1` (design §4.4, ERP §2.1, §3, §5.1).
 *
 * One item per **Instance** shell — an ERP equipment record is one physical unit (ERP §3). Type shells are excluded and
 * listed in `excluded` unless `includeTypes`, and then flagged. Values are read, never invented; what is empty is
 * listed in `missing`. `profile=sap-pm` only reports over-long values in `warnings`, it never truncates (ERP E-14).
 */
import { PRODUCT_VERSION, fill, tr, type Environment, type Isa95Path, type PublicExternalRef, type SpecificAssetIdPair } from '@aas/core';
import type { AasStore } from '@aas/store';
import { DERIVATION_PART } from '../../routes/derivation.js';
import type { ExportSource } from '../bundle-types.js';
import { EQUIPMENT_SCHEMA } from './columns.js';
import type { CsvRow } from './csv.js';
import { assetInformationOf, shellsOf, specificAssetIdsOf, type Json } from './elements.js';
import { assetRefsOf } from './join.js';
import { isProcessFile, type LocationEntry } from './location.js';
import { readNameplate, type NameplateValues } from './nameplate.js';
import { readinessMessage } from './readiness.js';
import { hasIntegrationStore } from './store.js';

export interface EquipmentItem {
  key: string;
  aasId: string;
  assetKind: string | null;
  typeAasId: string | null;
  packageId: string;
  revision: number;
  nameplate: NameplateValues;
  physical: { weight: { value: number | null; unit: string | null } | null };
  location: { path: string[]; isa95: { site: string | null; area: string | null; workCenter: string | null } };
  specificAssetIds: SpecificAssetIdPair[];
  externalRefs: PublicExternalRef[];
  sourcePaths?: Record<string, string>;
  missing: string[];
  warnings: string[];
}

export interface ExcludedShell {
  packageId: string;
  aasId: string | null;
  reason: string;
}

export interface EquipmentOptions {
  lang: string;
  includeTypes: boolean;
  trace: boolean;
  profile?: 'sap-pm';
}

/** SAP PM equipment short text (EQKTX) holds 40 characters (ERP §2.1) */
const SAP_PM_DESCRIPTION_MAX = 40;

async function typeAasIdOf(store: AasStore, packageId: string): Promise<string | null> {
  const file = (await store.packageFiles(packageId)).find((f) => f.part === DERIVATION_PART);
  if (!file) return null;
  try {
    const record = JSON.parse(new TextDecoder().decode(file.data)) as { sourcePackageId?: unknown };
    if (typeof record.sourcePackageId !== 'string' || !(await store.getPackage(record.sourcePackageId))) return null;
    const shell = shellsOf(await store.getEnvironment(record.sourcePackageId))[0];
    return typeof shell?.['id'] === 'string' ? shell['id'] : null;
  } catch {
    return null; // a corrupted sidecar is treated as no link, as routes/derivation.ts does
  }
}

function isa95Columns(isa95: Isa95Path | null | undefined): EquipmentItem['location']['isa95'] {
  return { site: isa95?.site ?? null, area: isa95?.area ?? null, workCenter: isa95?.workCenter ?? null };
}

/** Equipment items of one package plus the shells it leaves out */
export async function projectPackageEquipment(
  store: AasStore,
  packageId: string,
  locations: Map<string, LocationEntry[]>,
  options: EquipmentOptions,
  environment?: Environment,
): Promise<{ items: EquipmentItem[]; excluded: ExcludedShell[] }> {
  const record = await store.getPackage(packageId);
  if (!record) return { items: [], excluded: [] };
  const env = environment ?? (await store.getEnvironment(packageId));
  // Company / line / process files are organisation, not equipment — they have no row in an equipment register
  if (isProcessFile(env)) return { items: [], excluded: [] };
  const doc = hasIntegrationStore(store) ? (await store.getExternalRefs(packageId))?.value : undefined;
  const items: EquipmentItem[] = [];
  const excluded: ExcludedShell[] = [];
  let typeAasId: string | null | undefined;

  for (const shell of shellsOf(env)) {
    const info = assetInformationOf(shell);
    const aasId = typeof shell['id'] === 'string' ? shell['id'] : null;
    const key = typeof info['globalAssetId'] === 'string' && info['globalAssetId'] !== '' ? info['globalAssetId'] : null;
    const assetKind = typeof info['assetKind'] === 'string' ? info['assetKind'] : null;
    const read = readNameplate(env, shell, options.lang);
    if (key === null || aasId === null) {
      excluded.push({ packageId, aasId, reason: tr('globalAssetId가 없어 설비 키를 만들 수 없습니다.') });
      continue;
    }
    const isType = assetKind === 'Type';
    const typeReason = read.nameplate.serialNumber !== null ? readinessMessage('INT-1') : tr('형식(Type) 셸입니다 — 실물 한 대가 아닙니다.');
    if (isType && !options.includeTypes) {
      excluded.push({ packageId, aasId, reason: typeReason });
      continue;
    }
    const warnings: string[] = isType ? [typeReason] : [];
    const designation = read.nameplate.productDesignation;
    if (options.profile === 'sap-pm' && designation !== null && [...designation].length > SAP_PM_DESCRIPTION_MAX) {
      warnings.push(
        fill(tr('sap-pm: {0}이(가) {1}자입니다 (최대 {2}자).'), {
          0: 'productDesignation',
          1: [...designation].length,
          2: SAP_PM_DESCRIPTION_MAX,
        }),
      );
    }
    typeAasId ??= await typeAasIdOf(store, packageId);
    const location = (locations.get(key) ?? []).find((entry) => entry.packageId !== packageId);
    items.push({
      key,
      aasId,
      assetKind,
      typeAasId,
      packageId,
      revision: record.revision,
      nameplate: read.nameplate,
      physical: { weight: read.weight },
      location: { path: location?.path ?? [], isa95: isa95Columns(location?.isa95) },
      specificAssetIds: specificAssetIdsOf(shell as Json),
      externalRefs: assetRefsOf(doc, key),
      ...(options.trace ? { sourcePaths: read.sourcePaths } : {}),
      missing: read.missing,
      warnings,
    });
  }
  return { items, excluded };
}

export function compareItems(a: { key: string; aasId: string }, b: { key: string; aasId: string }): number {
  return a.key.localeCompare(b.key) || a.aasId.localeCompare(b.aasId);
}

export type { ExportSource } from '../bundle-types.js';

export function exportSource(instanceId: string | null): ExportSource {
  return { tool: 'VEXPLOR AAS Studio', version: PRODUCT_VERSION, instanceId };
}

export interface EquipmentExport {
  schema: typeof EQUIPMENT_SCHEMA;
  exportedAt: string;
  source: ExportSource;
  language: string;
  items: EquipmentItem[];
  excluded: ExcludedShell[];
}

/** Flat CSV row — the column keys of EQUIPMENT_V1_COLUMNS */
export function equipmentRow(item: EquipmentItem): CsvRow {
  const plate = item.nameplate;
  return {
    key: item.key,
    aasId: item.aasId,
    assetKind: item.assetKind,
    typeAasId: item.typeAasId,
    packageId: item.packageId,
    revision: item.revision,
    'nameplate.manufacturer': plate.manufacturer,
    'nameplate.productDesignation': plate.productDesignation,
    'nameplate.productFamily': plate.productFamily,
    'nameplate.modelNumber': plate.modelNumber,
    'nameplate.orderCode': plate.orderCode,
    'nameplate.serialNumber': plate.serialNumber,
    'nameplate.yearOfConstruction': plate.yearOfConstruction,
    'nameplate.dateOfManufacture': plate.dateOfManufacture,
    'nameplate.productUri': plate.productUri,
    'nameplate.markings': plate.markings,
    'physical.weight.value': item.physical.weight?.value ?? null,
    'physical.weight.unit': item.physical.weight?.unit ?? null,
    'location.path': item.location.path.join('/'),
    'location.isa95.site': item.location.isa95.site,
    'location.isa95.area': item.location.isa95.area,
    'location.isa95.workCenter': item.location.isa95.workCenter,
    specificAssetIds: item.specificAssetIds.map((pair) => `${pair.name}=${pair.value}`),
    externalRefs: item.externalRefs.map((ref) => `${ref.system}|${ref.type}|${ref.id}`),
    missing: item.missing,
    warnings: item.warnings,
  };
}
