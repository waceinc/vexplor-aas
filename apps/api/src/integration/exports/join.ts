/**
 * The `asset` join block of runtime and projection events (design §2.2) and the resolver the detector and projector
 * share (`createJoinResolver`, §13.4).
 *
 * Join keys are `globalAssetId` and external references only — never idShort, display name, list index or file name
 * (ERP §7.4). Sensitive refs and cost centres never leave through here (D1).
 */
import {
  parsePackageIntegrationConfig,
  type AssetJoin,
  type AssetJoinResolver,
  type AssetKind,
  type PackageIntegrationConfig,
  type PublicExternalRef,
} from '@aas/core';
import type { AasStore, ExternalRefsDoc } from '@aas/store';
import { assetInformationOf, shellsOf, specificAssetIdsOf, type Json } from './elements.js';
import { buildLocationIndex, isProcessFile, type LocationEntry, type ProcessFile } from './location.js';
import { serialNumberOf } from './nameplate.js';
import { allPackages, hasIntegrationStore } from './store.js';

/** Types never exported, projected or put in events, compared without case (D1, review L7) */
const SENSITIVE_TYPES = new Set(['costcenter']);

/** A ref that may appear in events and exports (D1: never sensitive, never a cost centre — in any spelling) */
export function isPublicRef(ref: { type: string; sensitive?: boolean }): boolean {
  return ref.sensitive !== true && !SENSITIVE_TYPES.has(ref.type.toLowerCase());
}

function compareRefs(a: PublicExternalRef, b: PublicExternalRef): number {
  return a.system.localeCompare(b.system) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
}

/** Public refs of one subject, sorted (system, type, id) */
export function publicRefsOf(
  doc: ExternalRefsDoc | undefined,
  match: (subject: ExternalRefsDoc['subjects'][number]['subject']) => boolean,
): PublicExternalRef[] {
  const out: PublicExternalRef[] = [];
  for (const entry of doc?.subjects ?? []) {
    if (!match(entry.subject)) continue;
    for (const ref of entry.refs) if (isPublicRef(ref)) out.push({ system: ref.system, type: ref.type, id: ref.id });
  }
  return out.sort(compareRefs);
}

export function assetRefsOf(doc: ExternalRefsDoc | undefined, globalAssetId: string | null): PublicExternalRef[] {
  if (globalAssetId === null) return [];
  return publicRefsOf(doc, (subject) => subject.kind === 'asset' && subject.globalAssetId === globalAssetId);
}

export async function packageConfigOf(store: AasStore, packageId: string): Promise<PackageIntegrationConfig | null> {
  if (!hasIntegrationStore(store)) return null;
  const stored = await store.getPackageIntegrationConfig(packageId);
  if (!stored || stored.value === null || stored.value === undefined) return null;
  const parsed = parsePackageIntegrationConfig(stored.value);
  return parsed.ok ? parsed.value : null;
}

/** Process files the store shows, ascending package id */
export async function loadProcessFiles(store: AasStore): Promise<ProcessFile[]> {
  const files: ProcessFile[] = [];
  for (const record of await allPackages(store)) {
    const environment = await store.getEnvironment(record.id);
    if (!isProcessFile(environment)) continue;
    files.push({ packageId: record.id, environment, config: await packageConfigOf(store, record.id) });
  }
  return files;
}

export async function loadLocationIndex(store: AasStore): Promise<Map<string, LocationEntry[]>> {
  return buildLocationIndex(await loadProcessFiles(store));
}

/** The join block of a package, or null when it does not exist */
export async function buildAssetJoin(
  store: AasStore,
  packageId: string,
  locations: Map<string, LocationEntry[]>,
): Promise<AssetJoin | null> {
  if (!(await store.getPackage(packageId))) return null;
  const environment = await store.getEnvironment(packageId);
  const shell: Json | undefined = shellsOf(environment)[0];
  const info = assetInformationOf(shell);
  const globalAssetId = typeof info['globalAssetId'] === 'string' && info['globalAssetId'] !== '' ? info['globalAssetId'] : null;
  const assetKind = typeof info['assetKind'] === 'string' ? (info['assetKind'] as AssetKind) : null;
  const doc = hasIntegrationStore(store) ? (await store.getExternalRefs(packageId))?.value : undefined;
  const appearances = globalAssetId === null ? [] : (locations.get(globalAssetId) ?? []).filter((entry) => entry.packageId !== packageId);
  const first = appearances[0];
  return {
    globalAssetId,
    aasId: typeof shell?.['id'] === 'string' ? shell['id'] : null,
    packageId,
    assetKind,
    serialNumber: shell ? serialNumberOf(environment, shell) : null,
    specificAssetIds: specificAssetIdsOf(shell),
    externalRefs: assetRefsOf(doc, globalAssetId),
    path: first ? first.path : [],
    isa95: first ? first.isa95 : null,
    ...(appearances.length > 1 ? { pathAmbiguous: true as const } : {}),
  };
}

/**
 * Cached resolver. `invalidate()` drops everything: a location depends on every process file, so one model change can
 * move the path of another package. Rebuilding reads every package once — cheap next to a collection cycle.
 */
export function createJoinResolver(
  store: AasStore,
  _publicBaseUrl?: string,
): AssetJoinResolver & { invalidate(packageId?: string): void } {
  let locations: Promise<Map<string, LocationEntry[]>> | undefined;
  const joins = new Map<string, Promise<AssetJoin | null>>();
  let generation = 0;

  const resolver = (packageId: string): Promise<AssetJoin | null> => {
    const cached = joins.get(packageId);
    if (cached) return cached;
    const started = generation;
    if (!locations) {
      const loading = loadLocationIndex(store);
      locations = loading;
      loading.catch(() => {
        if (locations === loading) locations = undefined;
      });
    }
    const pending = locations.then((index) => buildAssetJoin(store, packageId, index));
    joins.set(packageId, pending);
    // A failed lookup must not stay cached; an invalidation during the lookup already dropped the entry
    pending.catch(() => {
      if (generation === started) joins.delete(packageId);
    });
    return pending;
  };
  return Object.assign(resolver, {
    invalidate(_packageId?: string): void {
      generation += 1;
      locations = undefined;
      joins.clear();
    },
  });
}
