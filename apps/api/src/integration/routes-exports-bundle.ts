/**
 * Integration bundle (design §4.4) — every export of the visible files in **one zip**, so another system (an ERP
 * import job, a CMMS, a VEXPLOR Logic Studio tenant) takes the whole picture in one step instead of five calls per file.
 *
 *     GET /integrations/exports/bundle[?packageId=…][&lang=…]   → vexplor.integrationBundle-1-<date>.zip
 *
 *     manifest.json                         vexplor.integrationBundle/1 — what is inside, sha256 and item count per part
 *     equipment.json                        vexplor.equipmentMaster/1 (Type shells included, flagged by assetKind)
 *     packages/<packageId>/hierarchy.json   kr.vexplor.aas.hierarchy.v1   — when the file has HierarchicalStructures
 *     packages/<packageId>/bom.json         vexplor.bom/1                 — when the file has a BOM
 *     packages/<packageId>/maintenance.json vexplor.maintenancePlan/1     — when the file has maintenance tasks
 *     packages/<packageId>/documents.json   vexplor.documents/1           — when the file has documents
 *
 * Important: the bundle **calls the single export routes themselves**. It must never project anything on its own — two
 *    code paths for "the equipment master" would drift, and the bundle would quietly disagree with the single exports
 *    integrators already validated against. Every part is byte-for-byte the JSON the single route answers.
 * Important: one frozen timestamp for every part, sorted entries, fixed zip mtime — two bundles without an edit differ
 *    only in `exportedAt`, exactly like the single exports (ERP E-5).
 * Important: a 422 from a single export (no hierarchy, no BOM, BOM root mismatch) is not a failure of the bundle — it is
 *    recorded under `skipped` with the same code and message, so the receiver can show why a part is missing.
 * Important: JSON only. CSV is for people and spreadsheet templates; a program reading a bundle wants the typed form.
 * Important: Type shells are included on purpose — a receiver keeps them as "models" next to the Instance rows
 *    (each item's `assetKind` says which). Leaving them out would make the bundle lose what the files describe.
 */
import { createHash } from 'node:crypto';

import { zipArchive } from '@aas/aasx';
import type { PackageRecord } from '@aas/store';
import { ApiError, type ApiRequest, type ApiResponse } from '../http.js';
import type { Route } from '../router.js';
import { exportFileName } from './exports/csv.js';
import type { ExportSource } from './exports/equipment.js';

export const BUNDLE_SCHEMA = 'vexplor.integrationBundle/1';

/** Per-file exports, in the order they appear in the manifest */
const PER_PACKAGE_KINDS = ['hierarchy', 'bom', 'maintenance', 'documents'] as const;
type PerPackageKind = (typeof PER_PACKAGE_KINDS)[number];

export interface BundlePart {
  path: string;
  schema: string;
  packageId: string | null;
  items: number;
  sha256: string;
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  exportedAt: string;
  source: ExportSource;
  language: string;
  packages: { packageId: string; name: string; revision: number }[];
  parts: BundlePart[];
  skipped: { packageId: string; kind: PerPackageKind; code: string; message: string }[];
}

interface ExportBody {
  schema: string;
  source: ExportSource;
  items: unknown[];
  packageId?: string;
  revision?: number;
  excluded?: { packageId: string }[];
}

const encoder = new TextEncoder();
const sha256 = (data: Uint8Array): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const encodeJson = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

/** Calls one single-export route as if the client had — same request, same principal, only path and query replaced */
async function callExport(routes: readonly Route[], request: ApiRequest, kind: string, query: Record<string, string>): Promise<ExportBody> {
  const path = `/integrations/exports/${kind}`;
  const route = routes.find((candidate) => candidate.method === 'GET' && candidate.pattern === path);
  // Important: a missing route here is a wiring bug, not a client error — fail loudly instead of shipping a thin bundle
  if (!route) throw new ApiError(500, 'InternalError', `export route not found: ${path}`);
  const response: ApiResponse = await route.handle({ request: { ...request, path, query, queryAll: {} }, params: {} });
  return response.body as ExportBody;
}

/**
 * The bundle route. `singleRoutes(stamp)` builds the single export routes with a frozen clock and `packagesOf` lists
 * the visible files (the workspace-scoped store) — both passed in rather than imported, so this file cannot grow its
 * own copy of either.
 */
export function exportBundleRoute(
  now: () => string,
  singleRoutes: (stamp: string) => Route[],
  packagesOf: (packageId: string | undefined) => Promise<PackageRecord[]>,
): Route {
  return {
    method: 'GET',
    pattern: '/integrations/exports/bundle',
    async handle({ request }) {
      const stamp = now();
      const routes = singleRoutes(stamp);
      const lang = (request.query['lang'] ?? 'ko').trim() || 'ko';
      const only = request.query['packageId'] || undefined;
      const scope: Record<string, string> = only ? { packageId: only } : {};

      // The equipment master decides which files are in the bundle: it lists the visible ones (404 for an invisible id)
      const equipment = await callExport(routes, request, 'equipment', { format: 'json', includeTypes: '1', lang, ...scope });
      const files: Record<string, Uint8Array> = {};
      const parts: BundlePart[] = [];
      const add = (path: string, body: ExportBody, packageId: string | null): void => {
        const data = encodeJson(body);
        files[path] = data;
        parts.push({ path, schema: body.schema, packageId, items: body.items.length, sha256: sha256(data) });
      };
      add('equipment.json', equipment, null);

      // Every visible file (Instance, Type and process files alike) — not the equipment rows: a process file has no
      // Instance shell, and its plant hierarchy would never reach the bundle
      const packages = (await packagesOf(only)).map((record) => ({ packageId: record.id, name: record.name, revision: record.revision }));
      const skipped: BundleManifest['skipped'] = [];
      for (const record of packages) {
        for (const kind of PER_PACKAGE_KINDS) {
          let body: ExportBody;
          try {
            body = await callExport(routes, request, kind, { format: 'json', packageId: record.packageId, lang });
          } catch (caught) {
            if (caught instanceof ApiError && caught.status === 422) {
              skipped.push({ packageId: record.packageId, kind, code: caught.code, message: caught.message });
              continue;
            }
            throw caught;
          }
          // An empty maintenance plan or document list carries nothing — leave the part out instead of shipping noise
          if (body.items.length === 0) continue;
          add(`packages/${encodeURIComponent(record.packageId)}/${kind}.json`, body, record.packageId);
        }
      }

      const manifest: BundleManifest = { schema: BUNDLE_SCHEMA, exportedAt: stamp, source: equipment.source, language: lang, packages, parts, skipped };
      files['manifest.json'] = encodeJson(manifest);
      return {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${exportFileName(BUNDLE_SCHEMA, stamp, 'zip')}"`,
        },
        body: zipArchive(files),
      };
    },
  };
}
