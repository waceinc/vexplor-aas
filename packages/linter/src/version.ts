/**
 * Version helpers for rules — which metamodel version (IDTA-01001 V3.0 · V3.1 · V3.2) a check judges by.
 *
 * Important: the judged version is the **file's** version. A 3.0 file is held to 3.0 (no hyphen in idShort, AASd-120
 *    applies); a 3.1 file is held to 3.1. Judging every file by the newest version would reject valid 3.0 files, and
 *    judging every file by 3.0 — what this linter did before — rejects valid 3.1 files (99 AASd-090 errors on the
 *    official 3.1.2 examples).
 *
 * A JSON file carries no version marker. When its version is guessed from content it may be several versions at
 * once (LintMetamodel.candidates), and a rule convicts only what is wrong in **every** candidate:
 *   - a constraint removed or loosened in version v holds only if no candidate reaches v → `!mayBe(ctx, v)`
 *   - a constraint added in version v holds only if every candidate reaches v              → `atLeast(ctx, v)`
 */
import { compareVersions, METAMODEL_VERSIONS, tr, type MetamodelVersion } from '@aas/core';
import type { LintContext, LintMetamodel, LintMetamodelInput } from './types.js';

/** Version assumed when the caller passes none — the verdict every caller got before versions were told apart */
export const DEFAULT_LINT_METAMODEL: LintMetamodel = { version: '3.0', source: 'default', inferred: true, candidates: ['3.0'] };

export function resolveMetamodel(input: LintMetamodelInput | undefined): LintMetamodel {
  if (!input) return { ...DEFAULT_LINT_METAMODEL, candidates: [...DEFAULT_LINT_METAMODEL.candidates] };
  const source = input.source ?? 'caller';
  let candidates: MetamodelVersion[] = [input.version];
  if (source === 'content') {
    // Without `fits` the guess is still "the lowest version that holds the content" — so it and every newer one
    const fits = input.fits ?? METAMODEL_VERSIONS.filter((v) => compareVersions(v, input.version) >= 0);
    if (fits.length > 0) candidates = [...fits];
  }
  return { version: input.version, source, inferred: input.inferred ?? source === 'content', candidates };
}

/** True when every version the file may be is `version` or newer — the test for a constraint added in `version` */
export function atLeast(ctx: LintContext, version: MetamodelVersion): boolean {
  return ctx.metamodel.candidates.every((v) => compareVersions(v, version) >= 0);
}

/** True when the file may be `version` or newer — a constraint removed in `version` then cannot be held against it */
export function mayBe(ctx: LintContext, version: MetamodelVersion): boolean {
  return ctx.metamodel.candidates.some((v) => compareVersions(v, version) >= 0);
}

/**
 * AASd-002 idShort pattern per version — the official JSON schemas:
 *   3.0.9  ^[a-zA-Z][a-zA-Z0-9_]*$                     one character allowed, no hyphen
 *   3.1 on ^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$       hyphen allowed (not last), at least two characters
 */
export const ID_SHORT_PATTERN_V30 = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const ID_SHORT_PATTERN_V31 = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/;

export function idShortPattern(version: MetamodelVersion): RegExp {
  return version === '3.0' ? ID_SHORT_PATTERN_V30 : ID_SHORT_PATTERN_V31;
}

/** Whether the idShort is valid in at least one version the file may be */
export function idShortFits(ctx: LintContext, idShort: string): boolean {
  return ctx.metamodel.candidates.some((v) => idShortPattern(v).test(idShort));
}

/** How to fix an idShort that breaks the 3.0 pattern — the 3.1 remedies talk about hyphens the other way round */
export function idShortRemedyV30(): string {
  return tr(
    '영문자로 시작하고 영문자 · 숫자 · 밑줄(_)만 쓰십시오. 메타모델 3.0 은 하이픈(-)을 받지 않습니다 — 하이픈을 쓰려면 파일을 3.1 이상으로 내보내십시오.',
  );
}
