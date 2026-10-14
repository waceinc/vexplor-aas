/**
 * 형식 → 호기 반영 — 「호기별로 나누기」로 만든 호기 파일이 원본(형식) 파일의 변경을 받아 오는 길(2026-10-13).
 *
 * 호기를 만들 때 형식의 값 사본(base)을 호기 파일 옆에 둔다 — `/.derivation/source.json`, role `bundle`이라
 * AASX 로 내보낼 때는 빠진다(모델·제출 파일을 바꾸지 않는다). 판정은 @aas/linter derivation.ts(3자 비교).
 *   GET    /packages/:id/derivation        연결 상태 + 반영 계획(미리보기)
 *   POST   /packages/:id/derivation/apply  고른 줄만 반영 { keys?: string[] } — 되돌리기(↶)에 그대로 남는다
 *   PUT    /packages/:id/derivation        형식 파일 연결 { sourcePackageId } — 이 기능 전에 만든 호기용. base = 지금 형식
 *   DELETE /packages/:id/derivation        연결 끊기
 * 반영은 서브모델 단위 updateIdentifiable 로 쓴다 — 이력·되돌리기·충돌 보호가 다른 편집과 같은 길을 탄다.
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

export const DERIVATION_PART = '/.derivation/source.json';

export interface DerivationRecord {
  version: 1;
  sourcePackageId: string;
  sourceName: string;
  /** 마지막으로 반영(또는 연결)한 시각 */
  appliedAt: string;
  snapshot: DerivationSnapshot;
}

/** 호기 파일에 실을 형식 사본 — importPackage 의 keep 에 넣으면 리비전이 1로 남는다 */
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
    return undefined; // 깨진 기록은 없는 것으로 본다 — 다시 연결하면 된다
  }
}

const count = (changes: readonly DerivationChange[], action: DerivationChange['action']): number =>
  changes.filter((change) => change.action === action).length;

export function derivationRoutes(store: AasStore): Route[] {
  /** 연결 상태와 계획 — 형식 파일이 사라졌으면 그 사실만 */
  const plan = async (packageId: string) => {
    if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
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
        if (!found.linked) throw new ApiError(409, 'Conflict', '이 파일은 형식 파일과 연결되어 있지 않습니다.');
        if ('sourceMissing' in found) throw new ApiError(409, 'Conflict', '형식 파일이 보관함에 없습니다 — 다시 연결하십시오.');
        const body = (request.body ?? {}) as { keys?: unknown };
        const wanted = Array.isArray(body.keys) ? new Set(body.keys.map(String)) : undefined;
        const chosen = found.changes.filter((change) => change.action === 'apply' && (!wanted || wanted.has(change.key)));
        const next = applyDerivation(found.mine, found.theirs, chosen);
        // 달라진 서브모델만 쓴다 — 이력·되돌리기가 다른 편집과 같은 길을 탄다
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
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const sourcePackageId = String(((request.body ?? {}) as { sourcePackageId?: unknown }).sourcePackageId ?? '');
        if (sourcePackageId === packageId) throw new ApiError(400, 'BadRequest', '자기 자신을 형식 파일로 연결할 수 없습니다.');
        const source = await store.getPackage(sourcePackageId);
        if (!source) throw new ApiError(404, 'NotFound', '형식 파일을 찾을 수 없습니다.');
        // base 는 「지금 형식」이다 — 그 전의 일은 알 수 없다. 지금 다른 값은 호기 고유 값으로 남는다
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
        if (!(await readDerivation(store, packageId))) throw new ApiError(404, 'NotFound', '연결이 없습니다.');
        await store.deletePackageFile(packageId, DERIVATION_PART);
        return noContent();
      },
    },
  ];
}
