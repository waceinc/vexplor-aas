/**
 * Store access shared by the export, external-reference and projector code (WP4).
 *
 * Route builders keep the agreed signature `(store: AasStore, deps) => Route[]` (design §13.3). Until WP1 merges, the
 * `AasStore` port does not yet extend `IntegrationStore`; after it does, `IntegrationAasStore` is just `AasStore` and
 * `integrationStore()` never fails. The runtime check keeps a half-wired server from crashing with "is not a function".
 */
import { fill, tr } from '@aas/core';
import type { AasStore, IntegrationStore, PackageRecord } from '@aas/store';
import { ApiError } from '../../http.js';

export type IntegrationAasStore = AasStore & IntegrationStore;

export function hasIntegrationStore(store: AasStore): store is IntegrationAasStore {
  const candidate = store as Partial<IntegrationStore>;
  return typeof candidate.getExternalRefs === 'function' && typeof candidate.appendEvents === 'function';
}

export function integrationStore(store: AasStore): IntegrationAasStore {
  if (!hasIntegrationStore(store)) {
    throw new ApiError(503, 'IntegrationsUnavailable', tr('이 저장소는 연동 기능을 지원하지 않습니다.'));
  }
  return store;
}

/** Every package the store shows (the scoped store filters by workspace), in id order */
export async function allPackages(store: AasStore): Promise<PackageRecord[]> {
  const out: PackageRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPackages({ limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out.sort((a, b) => comparePackageIds(a.id, b.id));
}

/** `pkg_2` before `pkg_10` — "the lowest package id wins" (design §2.2) must mean the numerically lowest */
export function comparePackageIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** The package or a 404 */
export async function requirePackage(store: AasStore, packageId: string): Promise<PackageRecord> {
  const record = await store.getPackage(packageId);
  if (!record) throw new ApiError(404, 'NotFound', fill(tr('패키지 {0}을(를) 찾을 수 없습니다.'), { 0: packageId }));
  return record;
}
