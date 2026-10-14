/**
 * AAS Registry & Discovery (IDTA Part 2).
 *
 * BaSyx runs this as a **separate service** — apps register their AAS, and other systems
 * look up "where that AAS is" by asset ID. When equipment is spread across servers, it cannot be found without this.
 *
 * Important: **we do not accept registrations; we derive them.** This server is also the repository, so it already knows
 *    what it holds. A registration step creates **moments when registration and reality diverge** (a common incident with BaSyx) —
 *    e.g. a file is deleted but remains in the registry. Deriving leaves no room for divergence.
 *
 * Important: for now only **reads (GET)** are exposed. Writes (POST/PUT/DELETE) that register AAS hosted on other servers
 *    need storage (a repository schema), so they are deferred to the next stage. They remain marked unimplemented in the spec coverage table —
 *    better than "pretending it exists".
 */
import type { AssetAdministrationShell, Environment, Submodel } from '@aas/core';
import type { AasStore } from '@aas/store';
import { encodeIdentifier } from '../base64url.js';
import { ApiError, json, pagedResponse, type ApiRequest } from '../http.js';
import type { Route } from '../router.js';
import { decodeIdentifier } from '../base64url.js';
import { fill, tr } from '@aas/core';

/** Interface names defined by the spec */
const AAS_INTERFACE = 'AAS-3.0';
const SUBMODEL_INTERFACE = 'SUBMODEL-3.0';

export interface RegistryOptions {
  /**
   * Address used to reach this server from outside. If absent, it is built from the request's Host header.
   * Important: if the address the registry advertises is wrong, nobody can find their way here — always set it behind a reverse proxy.
   */
  publicBaseUrl?: string;
}

function baseUrlOf(request: ApiRequest, options: RegistryOptions): string {
  if (options.publicBaseUrl) return options.publicBaseUrl.replace(/\/+$/, '');
  const host = request.headers['host'];
  if (!host) return '';
  const scheme = request.headers['x-forwarded-proto'] ?? 'http';
  return `${scheme}://${host}`;
}

interface Endpoint {
  interface: string;
  protocolInformation: {
    href: string;
    endpointProtocol: string;
    endpointProtocolVersion: string[];
  };
}

function endpoint(href: string, interfaceName: string): Endpoint {
  return {
    interface: interfaceName,
    protocolInformation: {
      href,
      endpointProtocol: 'HTTP',
      endpointProtocolVersion: ['1.1'],
    },
  };
}

export interface SubmodelDescriptor {
  id: string;
  idShort?: string;
  semanticId?: unknown;
  administration?: unknown;
  description?: unknown;
  displayName?: unknown;
  endpoints: Endpoint[];
}

export interface ShellDescriptor {
  id: string;
  idShort?: string;
  assetKind?: string;
  assetType?: string;
  globalAssetId?: string;
  specificAssetIds?: unknown[];
  administration?: unknown;
  description?: unknown;
  displayName?: unknown;
  endpoints: Endpoint[];
  submodelDescriptors: SubmodelDescriptor[];
}

function submodelDescriptor(submodel: Submodel, base: string, packageId: string): SubmodelDescriptor {
  const raw = submodel as unknown as Record<string, unknown>;
  const href = `${base}/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodel.id)}`;
  return {
    id: submodel.id,
    ...(submodel.idShort === undefined ? {} : { idShort: submodel.idShort }),
    ...(raw['semanticId'] === undefined ? {} : { semanticId: raw['semanticId'] }),
    ...(raw['administration'] === undefined ? {} : { administration: raw['administration'] }),
    ...(raw['description'] === undefined ? {} : { description: raw['description'] }),
    ...(raw['displayName'] === undefined ? {} : { displayName: raw['displayName'] }),
    endpoints: [endpoint(href, SUBMODEL_INTERFACE)],
  };
}

/** Attach only the submodels the AAS references — one that is in the file but not linked to it does not belong to that AAS */
function referencedSubmodels(shell: AssetAdministrationShell, environment: Environment): Submodel[] {
  const wanted = new Set(
    ((shell as unknown as Record<string, unknown>)['submodels'] as
      | { keys?: { value: string }[] }[]
      | undefined
      ?? []
    ).map((reference) => reference.keys?.[0]?.value ?? ''),
  );
  return (environment.submodels ?? []).filter((submodel) => wanted.has(submodel.id));
}

function shellDescriptor(
  shell: AssetAdministrationShell,
  environment: Environment,
  base: string,
  packageId: string,
): ShellDescriptor {
  const raw = shell as unknown as Record<string, unknown>;
  const asset = (raw['assetInformation'] ?? {}) as Record<string, unknown>;
  const href = `${base}/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(shell.id)}`;

  return {
    id: shell.id,
    ...(shell.idShort === undefined ? {} : { idShort: shell.idShort }),
    ...(asset['assetKind'] === undefined ? {} : { assetKind: String(asset['assetKind']) }),
    ...(asset['assetType'] === undefined ? {} : { assetType: String(asset['assetType']) }),
    ...(asset['globalAssetId'] === undefined
      ? {}
      : { globalAssetId: String(asset['globalAssetId']) }),
    ...(asset['specificAssetIds'] === undefined
      ? {}
      : { specificAssetIds: asset['specificAssetIds'] as unknown[] }),
    ...(raw['administration'] === undefined ? {} : { administration: raw['administration'] }),
    ...(raw['description'] === undefined ? {} : { description: raw['description'] }),
    ...(raw['displayName'] === undefined ? {} : { displayName: raw['displayName'] }),
    endpoints: [endpoint(href, AAS_INTERFACE)],
    submodelDescriptors: referencedSubmodels(shell, environment).map((submodel) =>
      submodelDescriptor(submodel, base, packageId),
    ),
  };
}

interface Held {
  descriptor: ShellDescriptor;
  packageId: string;
  updatedAt: string;
}

/**
 * Scan everything this server holds and build descriptors.
 * Important: the scan grows with the number of files. At hundreds of machines a separate index will be needed — for now it plainly scans everything.
 */
async function scan(store: AasStore, base: string): Promise<Held[]> {
  const out: Held[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPackages(cursor === undefined ? {} : { cursor });
    for (const record of page.items) {
      const environment = await store.getEnvironment(record.id);
      for (const shell of environment.assetAdministrationShells ?? []) {
        out.push({
          descriptor: shellDescriptor(shell, environment, base, record.id),
          packageId: record.id,
          updatedAt: String((record as unknown as Record<string, unknown>)['updatedAt'] ?? ''),
        });
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}

/**
 * Important: if the same AAS id is in two files, **only one is advertised.** With the same id twice in a registry,
 *    the caller cannot tell which to use — this actually happens when the same file is uploaded twice.
 *    The most recently changed file is kept. The overlap can be seen at `/registry-conflicts`.
 */
function dedupe(held: readonly Held[]): ShellDescriptor[] {
  const best = new Map<string, Held>();
  for (const entry of held) {
    const previous = best.get(entry.descriptor.id);
    if (!previous || entry.updatedAt > previous.updatedAt) best.set(entry.descriptor.id, entry);
  }
  return [...best.values()].map((entry) => entry.descriptor);
}

async function allDescriptors(store: AasStore, base: string): Promise<ShellDescriptor[]> {
  return dedupe(await scan(store, base));
}

/** Asset identifier from the query parameter — JSON wrapped in base64url (spec) */
function parseAssetIds(request: ApiRequest): { name: string; value: string }[] {
  const values = request.queryAll?.['assetIds'] ?? (request.query['assetIds'] ? [request.query['assetIds']] : []);
  const out: { name: string; value: string }[] = [];
  for (const raw of values) {
    let text = raw;
    try {
      // The spec requires base64url, but implementations sending raw JSON are common — accept both
      text = raw.trim().startsWith('{') ? raw : decodeIdentifier(raw);
    } catch {
      throw new ApiError(400, 'BadRequest', fill(tr('assetIds를 해석하지 못했습니다: {0}'), { 0: raw }));
    }
    try {
      const parsed = JSON.parse(text) as { name?: string; value?: string };
      // i18n-ignore — an internal signal swallowed by the catch right below, never sent out
      if (typeof parsed.value !== 'string') throw new Error('value 없음');
      out.push({ name: parsed.name ?? 'globalAssetId', value: parsed.value });
    } catch {
      throw new ApiError(400, 'BadRequest', fill(tr('assetIds가 SpecificAssetId 모양이 아닙니다: {0}'), { 0: text }));
    }
  }
  return out;
}

/** All asset identifiers the AAS has — globalAssetId also counts as one entry (discovery convention) */
function assetLinksOf(descriptor: ShellDescriptor): { name: string; value: string }[] {
  const links: { name: string; value: string }[] = [];
  if (descriptor.globalAssetId !== undefined) {
    links.push({ name: 'globalAssetId', value: descriptor.globalAssetId });
  }
  for (const item of descriptor.specificAssetIds ?? []) {
    const entry = item as { name?: string; value?: string };
    if (typeof entry.value === 'string') {
      links.push({ name: entry.name ?? 'specificAssetId', value: entry.value });
    }
  }
  return links;
}

export function registryRoutes(store: AasStore, options: RegistryOptions = {}): Route[] {
  const BASE = '/api/v3.0';

  const find = async (request: ApiRequest, id: string): Promise<ShellDescriptor> => {
    const all = await allDescriptors(store, baseUrlOf(request, options));
    const found = all.find((descriptor) => descriptor.id === id);
    if (!found) throw new ApiError(404, 'NotFound', fill(tr('등록된 AAS가 없습니다: {0}'), { 0: id }));
    return found;
  };

  return [
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors`,
      async handle({ request }) {
        let all = await allDescriptors(store, baseUrlOf(request, options));
        const assetKind = request.query['assetKind'];
        const assetType = request.query['assetType'];
        if (assetKind) all = all.filter((descriptor) => descriptor.assetKind === assetKind);
        if (assetType) all = all.filter((descriptor) => descriptor.assetType === assetType);
        return pagedResponse(all);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier`,
      async handle({ params, request }) {
        return json(200, await find(request, decodeIdentifier(params['aasIdentifier']!)));
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier/submodel-descriptors`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        return pagedResponse(descriptor.submodelDescriptors);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shell-descriptors/:aasIdentifier/submodel-descriptors/:submodelIdentifier`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        const wanted = decodeIdentifier(params['submodelIdentifier']!);
        const found = descriptor.submodelDescriptors.find((entry) => entry.id === wanted);
        if (!found) throw new ApiError(404, 'NotFound', fill(tr('그 AAS에 매달린 서브모델이 아닙니다: {0}'), { 0: wanted }));
        return json(200, found);
      },
    },
    {
      /** Submodel registry — where submodels are found directly without going through an AAS */
      method: 'GET',
      pattern: `${BASE}/submodel-descriptors`,
      async handle({ request }) {
        const all = await allDescriptors(store, baseUrlOf(request, options));
        const seen = new Map<string, SubmodelDescriptor>();
        for (const descriptor of all) {
          for (const submodel of descriptor.submodelDescriptors) seen.set(submodel.id, submodel);
        }
        return pagedResponse([...seen.values()]);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/submodel-descriptors/:submodelIdentifier`,
      async handle({ params, request }) {
        const wanted = decodeIdentifier(params['submodelIdentifier']!);
        const all = await allDescriptors(store, baseUrlOf(request, options));
        for (const descriptor of all) {
          const found = descriptor.submodelDescriptors.find((entry) => entry.id === wanted);
          if (found) return json(200, found);
        }
        throw new ApiError(404, 'NotFound', fill(tr('등록된 서브모델이 없습니다: {0}'), { 0: wanted }));
      },
    },
    {
      /**
       * Discovery — **find AAS by asset ID.** This is why this registry exists.
       * Field systems come with asset numbers (serial numbers, equipment codes), not AAS ids.
       */
      method: 'GET',
      pattern: `${BASE}/lookup/shells`,
      async handle({ request }) {
        const wanted = parseAssetIds(request);
        const all = await allDescriptors(store, baseUrlOf(request, options));
        if (wanted.length === 0) return pagedResponse(all.map((descriptor) => descriptor.id));

        const matches = all.filter((descriptor) => {
          const links = assetLinksOf(descriptor);
          // If several are given, **all** must match (spec: AND)
          return wanted.every((want) =>
            links.some((link) => link.value === want.value && (want.name === 'globalAssetId' || link.name === want.name)),
          );
        });
        return pagedResponse(matches.map((descriptor) => descriptor.id));
      },
    },
    {
      /**
       * Important: outside the spec — **duplicate id check**. The standard response returns only one, so a separate place
       *    is needed to report the duplication. It happens immediately when the same file is uploaded twice.
       */
      method: 'GET',
      pattern: '/registry-conflicts',
      async handle({ request }) {
        const held = await scan(store, baseUrlOf(request, options));
        const byId = new Map<string, Held[]>();
        for (const entry of held) {
          byId.set(entry.descriptor.id, [...(byId.get(entry.descriptor.id) ?? []), entry]);
        }
        const conflicts = [...byId.entries()]
          .filter(([, entries]) => entries.length > 1)
          .map(([id, entries]) => ({
            id,
            idShort: entries[0]!.descriptor.idShort,
            packages: entries.map((entry) => entry.packageId),
            /** The one returned in the standard response */
            serving: entries.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).packageId,
          }));
        return json(200, { total: held.length, conflicts });
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/lookup/shells/:aasIdentifier`,
      async handle({ params, request }) {
        const descriptor = await find(request, decodeIdentifier(params['aasIdentifier']!));
        return json(200, assetLinksOf(descriptor));
      },
    },
  ];
}
