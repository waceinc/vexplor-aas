/**
 * PKG-MM-VERSION — the declared metamodel version cannot hold what the file contains.
 *
 * Example: an XML file in the 3.0 namespace with an AssetKind Batch (3.2) or administration.createdAt (3.2), or a 3.0
 * file whose Entity has no entityType (required in 3.0, optional from 3.1). Such a file fails the schema of the
 * version it names, and a tool of that version reads it wrongly or not at all.
 *
 * Important: the differences come from the core's own table (scanFeatures, metamodel/features.ts) — the same list
 *    that decides a file's version and what lowering drops. Do not keep a second list here: a difference added to
 *    one and not the other would label a file 3.0 while this rule stays silent about it.
 *
 * Only when a version was **declared** or handed in by the caller (inferred=false — including a stored version the
 * API puts back on a re-read body): a version guessed from content is by construction
 * the lowest that holds the content, and with no version at all the file is judged as 3.0 the way it always was.
 * Differences another rule already reports are left to that rule, so one value is not reported twice:
 *   idShort-hyphen · idShort-single-char → KOSMO-*-1 (idShort pattern of the file's version)
 *   value-xml-char                       → AASd-130 (forbidden characters, every version)
 *   path-not-uri on File/value           → PKG-FILE-URI
 */
import { compareVersions, fill, getAtPointer, parentPointer, scanFeatures, tr, type FeatureHit } from '@aas/core';
import type { LintContext, Rule } from '../types.js';

// i18n-ignore — standard document name
const SOURCE = 'IDTA-01001 V3.0 · V3.1 · V3.2 JSON schema (admin-shell-io/aas-specs-metamodel)';

const OWNED_ELSEWHERE = new Set(['idShort-hyphen', 'idShort-single-char', 'value-xml-char']);

function ownedElsewhere(hit: FeatureHit, ctx: LintContext): boolean {
  if (OWNED_ELSEWHERE.has(hit.code)) return true;
  if (hit.code !== 'path-not-uri') return false;
  const owner = getAtPointer(ctx.environment, parentPointer(hit.pointer)) as { modelType?: unknown } | undefined;
  return owner?.modelType === 'File';
}

/** modelType of the nearest object at or above the pointer */
function elementTypeAt(ctx: LintContext, pointer: string): string {
  let current = pointer;
  while (current !== '') {
    const value = getAtPointer(ctx.environment, current) as { modelType?: unknown } | undefined;
    if (value && typeof value === 'object' && typeof value.modelType === 'string') return value.modelType;
    current = parentPointer(current);
  }
  return 'Environment';
}

/** KOSMO-style path: the deepest visited element on the way, then the rest of the pointer */
function kosmoPathAt(ctx: LintContext, pointer: string): string {
  let best: { pointer: string; kosmoPath: string } | undefined;
  for (const v of ctx.elements) {
    if ((pointer === v.pointer || pointer.startsWith(`${v.pointer}/`)) && (!best || v.pointer.length > best.pointer.length)) best = v;
  }
  return best ? best.kosmoPath + pointer.slice(best.pointer.length) : pointer;
}

function shown(hit: FeatureHit): string {
  if (typeof hit.value === 'string') return hit.value;
  if (hit.code === 'dataSpecificationUom') return 'DataSpecificationUom';
  return JSON.stringify(hit.value);
}

export const pkgMetamodelVersion: Rule = {
  id: 'PKG-MM-VERSION',
  layer: 'L1',
  get title() {
    return tr('선언한 메타모델 버전이 파일 내용을 담을 수 있어야 한다 — 3.0 선언 파일에 3.2 의 Batch · createdAt 등');
  },
  source: SOURCE,
  check(ctx, report) {
    // A guessed version (from content, or the 3.0 default) declares nothing that the content could contradict
    if (ctx.metamodel.inferred) return;
    const declared = ctx.metamodel.version;

    for (const hit of scanFeatures(ctx.environment)) {
      if (ownedElsewhere(hit, ctx)) continue;
      const tooNew = compareVersions(hit.since, declared) > 0;
      const tooOld = hit.until !== undefined && compareVersions(hit.until, declared) < 0;
      if (!tooNew && !tooOld) continue;

      const base = {
        severity: 'error' as const,
        elementType: elementTypeAt(ctx, hit.pointer),
        key: hit.field,
        pointer: hit.pointer,
        kosmoPath: kosmoPathAt(ctx, hit.pointer),
        fixable: false,
      };
      if (tooOld) {
        report({
          ...base,
          message: fill(tr('메타모델 V{0} 스키마가 받지 않는 값입니다: {1} = {2} (V{3} 까지만 허용)'), {
            0: declared,
            1: hit.field,
            2: shown(hit),
            3: hit.until,
          }),
          remedy: fill(tr('값을 V{0} 에 맞게 고치거나 파일을 V{1} 로 내보내십시오.'), { 0: declared, 1: hit.until }),
        });
      } else if (hit.value === undefined) {
        report({
          ...base,
          message: fill(tr('메타모델 V{0} 에서는 {1} 이(가) 필수인데 없습니다 (V{2} 부터 선택 항목).'), {
            0: declared,
            1: hit.field,
            2: hit.since,
          }),
          remedy: fill(tr('{0} 을(를) 채우거나 파일을 V{1} 이상으로 내보내십시오.'), { 0: hit.field, 1: hit.since }),
        });
      } else {
        report({
          ...base,
          message: fill(tr('메타모델 V{0} 파일에는 쓸 수 없는 값입니다: {1} = {2} (V{3} 부터)'), {
            0: declared,
            1: hit.field,
            2: shown(hit),
            3: hit.since,
          }),
          remedy: fill(tr('파일을 V{0} 이상으로 내보내거나, V{1} 에 맞게 값을 고치십시오.'), { 0: hit.since, 1: declared }),
        });
      }
    }
  },
};
