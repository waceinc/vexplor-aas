/**
 * Export and readiness routes (design §4.4, §8). All read-only; every export answers `format=json|csv`.
 *
 * Determinism: rows are ordered by key and business key, so two exports without an edit differ only in `exportedAt`
 * (ERP E-5). The store passed in is the workspace-scoped one, so a viewer sees only what the workspace shows.
 */
import { fill, tr } from '@aas/core';
import type { AasStore } from '@aas/store';
import { ApiError, json, type ApiRequest, type ApiResponse } from '../http.js';
import type { Route } from '../router.js';
import type { IntegrationRouteDeps } from './deps.js';
import { bomRow, readBom } from './exports/bom.js';
import {
  BOM_SCHEMA,
  BOM_V1_COLUMNS,
  DOCUMENTS_SCHEMA,
  DOCUMENTS_V1_COLUMNS,
  EQUIPMENT_SCHEMA,
  EQUIPMENT_V1_COLUMNS,
  HIERARCHY_SCHEMA,
  HIERARCHY_V1_COLUMNS,
  MAINTENANCE_SCHEMA,
  MAINTENANCE_V1_COLUMNS,
} from './exports/columns.js';
import { csvOptionsOf, csvResponse, toCsvText, type CsvRow } from './exports/csv.js';
import { createFileResolver, readDocuments } from './exports/documents.js';
import { compareItems, equipmentRow, exportSource, projectPackageEquipment, type EquipmentExport, type ExportSource } from './exports/equipment.js';
import { buildAssetDirectory, hierarchyRow, readHierarchyItems } from './exports/hierarchy.js';
import { loadLocationIndex, packageConfigOf } from './exports/join.js';
import { maintenanceRows, readMaintenancePlans } from './exports/maintenance.js';
import { bomRootMismatchMessage, readinessChecks } from './exports/readiness.js';
import { allPackages, hasIntegrationStore, requirePackage } from './exports/store.js';
import { exportBundleRoute } from './routes-exports-bundle.js';

type Format = 'json' | 'csv';

function formatOf(request: ApiRequest): Format {
  const value = request.query['format'] ?? 'json';
  if (value !== 'json' && value !== 'csv') throw new ApiError(400, 'BadRequest', fill(tr('format은 json 또는 csv여야 합니다: {0}'), { 0: value }));
  return value;
}

function requiredPackageId(request: ApiRequest): string {
  const value = request.query['packageId'];
  if (!value) throw new ApiError(400, 'BadRequest', tr('packageId가 필요합니다.'));
  return value;
}

/** MLP language: `lang` query (default ko). Falls back to en, then the first entry, inside textOf */
function languageOf(request: ApiRequest): string {
  return (request.query['lang'] ?? 'ko').trim() || 'ko';
}

export async function instanceIdOf(store: AasStore): Promise<string | null> {
  if (!hasIntegrationStore(store)) return null;
  const value = (await store.getServerIntegrationConfig())?.value as { instanceId?: unknown } | undefined;
  return typeof value?.instanceId === 'string' && value.instanceId !== '' ? value.instanceId : null;
}

interface Envelope {
  schema: string;
  exportedAt: string;
  source: ExportSource;
}

async function envelope(store: AasStore, schema: string, now: () => string, deps?: IntegrationRouteDeps): Promise<Envelope> {
  // The server's instance id (the same one events carry as `source`) — the stored config only as a fallback
  const instanceId = deps?.services ? await deps.services.instanceId() : await instanceIdOf(store);
  return { schema, exportedAt: now(), source: exportSource(instanceId) };
}

function respond(format: Format, request: ApiRequest, head: Envelope, body: Record<string, unknown>, columns: readonly string[], rows: () => CsvRow[]): ApiResponse {
  if (format === 'json') return json(200, { ...head, ...body });
  const text = toCsvText(columns, rows(), { ...csvOptionsOf(request.query), schema: head.schema });
  return csvResponse(text, head.schema, head.exportedAt);
}

export interface ExportRouteOptions {
  now?: () => string;
}

export function exportRoutes(store: AasStore, deps: IntegrationRouteDeps, options: ExportRouteOptions = {}): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  // The bundle is built from these very routes, each time with one frozen clock (routes-exports-bundle.ts)
  return [
    ...singleExportRoutes(store, deps, now),
    exportBundleRoute(
      now,
      (stamp) => singleExportRoutes(store, deps, () => stamp),
      async (packageId) => (packageId ? [await requirePackage(store, packageId)] : allPackages(store)),
    ),
  ];
}

function singleExportRoutes(store: AasStore, deps: IntegrationRouteDeps, now: () => string): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/integrations/exports/equipment',
      async handle({ request }) {
        const format = formatOf(request);
        const profile = request.query['profile'];
        if (profile !== undefined && profile !== 'sap-pm') throw new ApiError(400, 'BadRequest', fill(tr('알 수 없는 profile입니다: {0}'), { 0: profile }));
        const packageId = request.query['packageId'];
        const packageIds = packageId ? [(await requirePackage(store, packageId)).id] : (await allPackages(store)).map((record) => record.id);
        const locations = await loadLocationIndex(store);
        const lang = languageOf(request);
        const out: Pick<EquipmentExport, 'items' | 'excluded'> = { items: [], excluded: [] };
        for (const id of packageIds) {
          const result = await projectPackageEquipment(store, id, locations, {
            lang,
            includeTypes: request.query['includeTypes'] === '1',
            trace: request.query['trace'] === '1',
            ...(profile === 'sap-pm' ? { profile } : {}),
          });
          out.items.push(...result.items);
          out.excluded.push(...result.excluded);
        }
        out.items.sort(compareItems);
        out.excluded.sort((a, b) => a.packageId.localeCompare(b.packageId, 'en', { numeric: true }) || (a.aasId ?? '').localeCompare(b.aasId ?? ''));
        const head = await envelope(store, EQUIPMENT_SCHEMA, now, deps);
        return respond(format, request, head, { language: lang, ...out }, EQUIPMENT_V1_COLUMNS, () => out.items.map(equipmentRow));
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/exports/bom',
      async handle({ request }) {
        const format = formatOf(request);
        const record = await requirePackage(store, requiredPackageId(request));
        const environment = await store.getEnvironment(record.id);
        const refs = hasIntegrationStore(store) ? (await store.getExternalRefs(record.id))?.value : undefined;
        const bom = readBom(environment, refs);
        if (!bom.ok) {
          if (bom.reason === 'root-mismatch') {
            throw new ApiError(422, 'BomRootMismatch', bomRootMismatchMessage(bom.entryGlobalAssetId, bom.shellGlobalAssetId));
          }
          const reason =
            bom.reason === 'no-asset'
              ? tr('셸에 globalAssetId가 없어 BOM 머리 키를 만들 수 없습니다.')
              : bom.reason === 'process-file'
                ? tr('회사·라인·공정 파일의 계층은 BOM이 아닙니다 — 계층 내보내기를 쓰십시오.')
                : tr('이 패키지에 HierarchicalStructures가 없습니다.');
          throw new ApiError(422, 'NoBom', reason);
        }
        const head = await envelope(store, BOM_SCHEMA, now, deps);
        const body = { packageId: record.id, revision: record.revision, rootKey: bom.rootKey, items: bom.rows };
        return respond(format, request, head, body, BOM_V1_COLUMNS, () => bom.rows.map(bomRow));
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/exports/hierarchy',
      async handle({ request }) {
        const format = formatOf(request);
        const record = await requirePackage(store, requiredPackageId(request));
        const config = await packageConfigOf(store, record.id);
        const read = readHierarchyItems(await store.getEnvironment(record.id), config, await buildAssetDirectory(store), record.id);
        if (!read) throw new ApiError(422, 'NoHierarchy', tr('이 패키지에 HierarchicalStructures가 없습니다.'));
        const head = await envelope(store, HIERARCHY_SCHEMA, now, deps);
        const body = { packageId: record.id, revision: record.revision, site: config?.isa95.site ?? null, items: read.items, warnings: read.warnings };
        return respond(format, request, head, body, HIERARCHY_V1_COLUMNS, () => read.items.map(hierarchyRow));
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/exports/maintenance',
      async handle({ request }) {
        const format = formatOf(request);
        const record = await requirePackage(store, requiredPackageId(request));
        const resolver = createFileResolver(record.id, await store.packageFiles(record.id), deps.publicBaseUrl);
        const plans = readMaintenancePlans(await store.getEnvironment(record.id), languageOf(request), record.revision, resolver);
        const head = await envelope(store, MAINTENANCE_SCHEMA, now, deps);
        return respond(format, request, head, { packageId: record.id, revision: record.revision, items: plans }, MAINTENANCE_V1_COLUMNS, () => maintenanceRows(plans));
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/exports/documents',
      async handle({ request }) {
        const format = formatOf(request);
        const record = await requirePackage(store, requiredPackageId(request));
        const resolver = createFileResolver(record.id, await store.packageFiles(record.id), deps.publicBaseUrl);
        const rows = readDocuments(await store.getEnvironment(record.id), languageOf(request), resolver);
        const head = await envelope(store, DOCUMENTS_SCHEMA, now, deps);
        return respond(format, request, head, { packageId: record.id, revision: record.revision, items: rows }, DOCUMENTS_V1_COLUMNS, () => rows as unknown as CsvRow[]);
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/readiness',
      async handle({ request }) {
        const packageId = request.query['packageId'];
        const records = packageId ? [await requirePackage(store, packageId)] : await allPackages(store);
        const items = [];
        for (const record of records) items.push({ packageId: record.id, checks: readinessChecks(await store.getEnvironment(record.id)) });
        return json(200, { items });
      },
    },
  ];
}
