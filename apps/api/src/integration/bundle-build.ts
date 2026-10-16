/**
 * The integration bundle **without a server** — AASX files in, the same `vexplor.integrationBundle/1` out.
 *
 *     const { zip, manifest, files } = await buildBundle([{ name: 'unit-1.aasx', data }], { exportedAt })
 *
 * Another product (a VEXPLOR Logic Studio tenant taking an AASX by drag and drop) needs exactly what
 * `GET /integrations/exports/bundle` answers, but has no AAS Studio server to ask. This is shipped to it as the
 * `@aas/bundle` release tarball (scripts/pack-libraries.mjs).
 *
 * Important: this builds **nothing of its own**. The files go into a fresh in-memory store exactly as `POST /packages`
 *    stores an upload (same reader, same original-bytes record, same order), and the bundle comes from the very
 *    `exportRoutes` the server mounts. A second projection of "the equipment master" would drift from the one
 *    integrators validated against; this way the same files with the same clock give the same bytes, which
 *    test/integration-bundle-build.test.ts checks by sha256 against the API.
 * Important: package ids follow the input order (`pkg_1`, `pkg_2`, …) as in a fresh server. Give the files in a fixed
 *    order and a fixed `exportedAt` and the zip is byte-for-byte reproducible.
 * Important: the public types live in `bundle-types.ts` and here only. The tarball ships these two declaration files;
 *    nothing in this file's exported signatures may point at another file of the API.
 */
import { readAasx, unzipArchive, type AasxLimits } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { ApiError, type ApiRequest } from '../http.js';
import { originalFile } from '../routes/bundle-files.js';
import type { BundleManifest } from './bundle-types.js';
import { exportRoutes } from './routes-exports.js';
import { interfacesOf } from '../edge/read-list.js';
import type { Environment } from '@aas/core';
import type { ReadListInterface } from './bundle-types.js';

export * from './bundle-types.js';

export interface BundleInput {
  /** File name as an upload would carry it — it appears in the manifest's `packages[].name` */
  name: string;
  /** The AASX bytes */
  data: Uint8Array;
}

export interface BuildBundleOptions {
  /** MLP language for names and texts (default `ko`, falling back to `en`, then the first entry) */
  lang?: string;
  /** The one timestamp every part carries (default: now). Fix it to get a reproducible zip */
  exportedAt?: string;
  /** `source.instanceId` of every part (default `null` — no server) */
  instanceId?: string;
  /** Base URL for document links in documents.json and maintenance.json (default: relative links, as on a server without one) */
  publicBaseUrl?: string;
  /** AASX reading limits (default: the server's defaults) */
  limits?: Partial<AasxLimits>;
}

export interface BuiltBundle {
  /** The zip, exactly as the API route answers it */
  zip: Uint8Array;
  /** manifest.json, parsed */
  manifest: BundleManifest;
  /** Every entry of the zip by path, manifest.json included */
  files: Record<string, Uint8Array>;
  /** Package structure problems the reader tolerated, per input file (empty list = none) */
  warnings: { name: string; warnings: string[] }[];
}

/** Raised for a file that cannot be read or a bundle that cannot be built — `code` as the API would answer it */
export class BundleBuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fileName?: string,
  ) {
    super(message);
    this.name = 'BundleBuildError';
  }
}

export async function buildBundle(inputs: readonly BundleInput[], options: BuildBundleOptions = {}): Promise<BuiltBundle> {
  if (inputs.length === 0) throw new BundleBuildError('BadRequest', 'no AASX files given');
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const store = new InMemoryStore(() => exportedAt);
  if (options.instanceId !== undefined) await store.putServerIntegrationConfig({ instanceId: options.instanceId });

  const warnings: BuiltBundle['warnings'] = [];
  for (const input of inputs) {
    let read: ReturnType<typeof readAasx>;
    try {
      read = readAasx(input.data, options.limits ? { limits: options.limits } : {});
    } catch (caught) {
      throw new BundleBuildError('BadRequest', caught instanceof Error ? caught.message : String(caught), input.name);
    }
    // The same call POST /packages makes — the original bytes kept beside the model
    await store.importPackage({ name: input.name, package: read, keep: [originalFile(input.data)] });
    warnings.push({ name: input.name, warnings: read.warnings });
  }

  const routes = exportRoutes(store, { demo: false, ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}) }, { now: () => exportedAt });
  const route = routes.find((candidate) => candidate.method === 'GET' && candidate.pattern === '/integrations/exports/bundle');
  if (!route) throw new BundleBuildError('InternalError', 'bundle route not found');
  const request: ApiRequest = {
    method: 'GET',
    path: '/integrations/exports/bundle',
    query: { lang: options.lang ?? 'ko' },
    queryAll: {},
    headers: {},
  };
  let zip: Uint8Array;
  try {
    zip = (await route.handle({ request, params: {} })).body as Uint8Array;
  } catch (caught) {
    if (caught instanceof ApiError) throw new BundleBuildError(caught.code, caught.message);
    throw caught;
  }
  const files = unzipArchive(zip);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as BundleManifest;
  return { zip, manifest, files, warnings };
}

/**
 * What a remote collector would read from one file — the AID interfaces resolved into tags, exactly as AAS Studio's
 * read list does (docs/edge-contract.md §4), with the same stable tag ids for the same `packageId`.
 *
 * For a product that builds its own read list from AASX files (VEXPLOR Logic Studio) without writing an AID parser.
 * Only what can be read is listed: interfaces with an endpoint and a protocol the contract names, properties with an address.
 */
export function aidReadList(environment: Environment, packageId: string, intervalMs = 5000): ReadListInterface[] {
  return interfacesOf(packageId, environment as Parameters<typeof interfacesOf>[1], intervalMs);
}

