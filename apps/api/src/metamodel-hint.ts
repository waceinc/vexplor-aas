/**
 * Which metamodel version a package is stored as when it comes in (2026-10-19).
 *
 * - A file that declares its version (an XML namespace) is that version — nothing here overrides it.
 * - A model made by this tool (new equipment, a sample) is {@link NEW_MODEL_METAMODEL}: 3.1, the version KOSMO asks for
 *   and the IDTA templates are written in.
 * - JSON has no marker; the reader takes the lowest version that holds the content. The screen may say "this is a
 *   sample, store it as 3.1" with `?metamodel=3.1` — honoured only when the content fits that version.
 */
import { METAMODEL_VERSIONS, type MetamodelDetection, type MetamodelVersion } from '@aas/core';
import type { PackageMetamodel } from '@aas/store';
import type { ApiRequest } from './http.js';

export const NEW_MODEL_METAMODEL: Readonly<PackageMetamodel> = { version: '3.1', inferred: false };

/** Response header naming the version a downloaded AASX was written as */
export const METAMODEL_HEADER = 'x-aas-metamodel-version';

/** `?metamodel=` on an upload — an unknown value is ignored, the file's own version is used instead */
export function metamodelHintOf(request: ApiRequest): MetamodelVersion | undefined {
  const wanted = request.query['metamodel']?.replace(/^v/i, '');
  return wanted !== undefined && (METAMODEL_VERSIONS as readonly string[]).includes(wanted)
    ? (wanted as MetamodelVersion)
    : undefined;
}

/**
 * The version to store instead of the one read, or undefined to keep the one read.
 * Important: a declared version always wins, and a hint the content does not fit is dropped — storing 3.1 for a file
 *    with a one-letter idShort would make every default download of it fail.
 */
export function hintedMetamodel(
  read: { metamodel: MetamodelDetection },
  hint: MetamodelVersion | undefined,
): PackageMetamodel | undefined {
  if (hint === undefined || !read.metamodel.inferred || !read.metamodel.fits.includes(hint)) return undefined;
  return { version: hint, inferred: false };
}
