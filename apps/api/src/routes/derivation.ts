/**
 * Type → unit propagation — how unit files created by "split per unit" receive changes from the source (type) file (2026-10-13).
 *
 * When a unit is created, a copy of the type's values (base) is kept beside the unit file — `/.derivation/source.json`, role `bundle`, so
 * it is left out when exporting to AASX (the model and submitted files are not altered). The judgment is made by @aas/linter derivation.ts (three-way comparison).
 *   GET    /packages/:id/derivation        link status + propagation plan (preview)
 *   POST   /packages/:id/derivation/apply  apply only the chosen rows { keys?: string[] } — recorded as-is in undo (↶)
 *   PUT    /packages/:id/derivation        link a type file { sourcePackageId } — for units made before this feature. base = current type
 *   DELETE /packages/:id/derivation        unlink
 * Propagation writes via per-submodel updateIdentifiable — history, undo and conflict protection follow the same path as other edits.
 */
import type { Environment } from '@aas/core';
import {
  applyDerivation,
  nextSnapshot,
  planDerivation,
  snapshotOf,
  type DerivationChange,
  type DerivationSnapshot,
} from '@aas/linter';
import type { AasStore, PackageFileRecord } from '@aas/store';
import { ApiError, json, noContent } from '../http.js';
import type { Route } from '../router.js';
import { tr } from '@aas/core';

export const DERIVATION_PART = '/.derivation/source.json';

export interface DerivationRecord {
  version: 1;
  sourcePackageId: string;
  sourceName: string;
  /** Time of the last propagation (or link) */
  appliedAt: string;
  snapshot: DerivationSnapshot;
}

/** Type copy to carry in the unit file — putting it in importPackage's keep leaves the revision at 1 */
export function derivationFile(record: DerivationRecord): PackageFileRecord {
  return {
    part: DERIVATION_PART,
    role: 'bundle',
    contentType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(record)),
  };
}

export function newDerivation(sourcePackageId: string, sourceName: string, source: Environment): DerivationRecord {
  return { version: 1, sourcePackageId, sourceName, appliedAt: new Date().toISOString(), snapshot: snapshotOf(source) };
}

async function readDerivation(store: AasStore, packageId: string): Promise<DerivationRecord | undefined> {
  const file = (await store.packageFiles(packageId)).find((f) => f.part === DERIVATION_PART);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file.data)) as DerivationRecord;
    return parsed.version === 1 && typeof parsed.sourcePackageId === 'string' ? parsed : undefined;
  } catch {
    return undefined; // treat a corrupted record as absent — just relink
  }
}

const count = (changes: readonly DerivationChange[], action: DerivationChange['action']): number =>
  changes.filter((change) => change.action === action).length;

export function derivationRoutes(store: AasStore): Route[] {
  /** Link status and plan — if the type file has disappeared, only that fact */
  const plan = async (packageId: string) => {
    if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
    const record = await readDerivation(store, packageId);
    if (!record) return { linked: false as const };
    const source = await store.getPackage(record.sourcePackageId);
    if (!source) return { linked: true as const, record, sourceMissing: true as const };
    const [theirs, mine] = await Promise.all([store.getEnvironment(record.sourcePackageId), store.getEnvironment(packageId)]);
    return { linked: true as const, record, source, theirs, mine, changes: planDerivation(record.snapshot, theirs, mine) };
  };

  return [
    {
      method: 'GET',
      pattern: '/packages/:packageId/derivation',
      async handle({ params }) {
        const found = await plan(params['packageId']!);
        if (!found.linked) return json(200, { linked: false });
        const base = { linked: true, sourcePackageId: found.record.sourcePackageId, sourceName: found.record.sourceName, appliedAt: found.record.appliedAt };
        if ('sourceMissing' in found) return json(200, { ...base, sourceMissing: true, changes: [] });
        return json(200, {
          ...base,
          sourceName: found.source.name,
          changes: found.changes,
          counts: { apply: count(found.changes, 'apply'), skip: count(found.changes, 'skip') },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/derivation/apply',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const found = await plan(packageId);
        if (!found.linked) throw new ApiError(409, 'Conflict', tr('이 파일은 형식 파일과 연결되어 있지 않습니다.'));
        if ('sourceMissing' in found) throw new ApiError(409, 'Conflict', tr('형식 파일이 보관함에 없습니다 — 다시 연결하십시오.'));
        const body = (request.body ?? {}) as { keys?: unknown };
        const wanted = Array.isArray(body.keys) ? new Set(body.keys.map(String)) : undefined;
        const chosen = found.changes.filter((change) => change.action === 'apply' && (!wanted || wanted.has(change.key)));
        const next = applyDerivation(found.mine, found.theirs, chosen);
        // Write only the changed submodels — history and undo follow the same path as other edits
        const before = new Map((found.mine.submodels ?? []).map((sm) => [sm.id, JSON.stringify(sm)]));
        let written = 0;
        for (const submodel of next.submodels ?? []) {
          if (before.get(submodel.id) === JSON.stringify(submodel)) continue;
          await store.updateIdentifiable(packageId, 'Submodel', submodel.id, submodel as unknown as Record<string, unknown>);
          written += 1;
        }
        const record: DerivationRecord = {
          ...found.record,
          sourceName: found.source.name,
          appliedAt: new Date().toISOString(),
          snapshot: nextSnapshot(found.record.snapshot, found.theirs, found.changes, new Set(chosen.map((c) => c.key))),
        };
        await store.putPackageFile(packageId, derivationFile(record));
        return json(200, { applied: chosen.length, submodels: written, skipped: count(found.changes, 'skip') });
      },
    },
    {
      method: 'PUT',
      pattern: '/packages/:packageId/derivation',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const sourcePackageId = String(((request.body ?? {}) as { sourcePackageId?: unknown }).sourcePackageId ?? '');
        if (sourcePackageId === packageId) throw new ApiError(400, 'BadRequest', tr('자기 자신을 형식 파일로 연결할 수 없습니다.'));
        const source = await store.getPackage(sourcePackageId);
        if (!source) throw new ApiError(404, 'NotFound', tr('형식 파일을 찾을 수 없습니다.'));
        // base is "the current type" — anything before that cannot be known. Values that differ now remain as unit-specific values
        const record = newDerivation(sourcePackageId, source.name, await store.getEnvironment(sourcePackageId));
        await store.putPackageFile(packageId, derivationFile(record));
        return json(200, { linked: true, sourcePackageId, sourceName: source.name, appliedAt: record.appliedAt });
      },
    },
    {
      method: 'DELETE',
      pattern: '/packages/:packageId/derivation',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!(await readDerivation(store, packageId))) throw new ApiError(404, 'NotFound', tr('연결이 없습니다.'));
        await store.deletePackageFile(packageId, DERIVATION_PART);
        return noContent();
      },
    },
  ];
}
