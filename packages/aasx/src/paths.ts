/**
 * Package paths written as URIs — what V3.1 and V3.2 require of File/value, Resource/path and the thumbnail path.
 *
 * V3.0 accepts any text there, so attachments named with spaces or Korean letters (`/aasx/files/설명서 1.pdf`) are
 * common. The V3.1 / V3.2 schemas accept only an RFC 3986 URI reference, and the core refuses such a value when
 * writing those versions (metamodel/features.ts, `path-not-uri`). This module percent-encodes the value (UTF-8) and
 * renames the package part it points to the same way, so the reference and the part keep matching.
 *
 * Important: the part name in the ZIP, the relationship target and the Content_Types override are all the encoded
 *    form — OPC part names are URIs, so this is also what other packaging tools expect. A reader shows the original
 *    name with {@link decodeUriPath}; the stored model is never decoded (the file is the original).
 */
import { scanFeatures, setAtPointer, URI_REFERENCE_PATTERN, type Environment } from '@aas/core';
import { strToU8 } from 'fflate';
import { resolveTarget } from './opc.js';
import type { AasxFile, AasxPackage } from './package.js';

/** One value rewritten by {@link encodePackagePaths} */
export interface RenamedPath {
  /** JSON Pointer of the value in the environment */
  pointer: string;
  /** `value` (File) or `path` (Resource / thumbnail) */
  field: string;
  from: string;
  to: string;
  /** The package part renamed with it — absent when the value points outside the package (or to no part) */
  part?: { from: string; to: string };
}

/**
 * Characters RFC 2396 (the grammar the official pattern is built from) allows unescaped in a URI reference:
 * unreserved (alphanumerics and `-_.!~*'()`), reserved (`;/?:@&=+$,`) and `#` for a fragment.
 */
const ALLOWED = /[A-Za-z0-9\-_.!~*'();/?:@&=+$,#]/;
const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * Percent-encodes what a URI cannot hold — spaces, non-ASCII letters, `%` not starting an escape — as UTF-8 bytes.
 * Characters a URI allows, and escapes already present, are kept, so encoding twice changes nothing.
 */
export function encodeUriPath(value: string): string {
  let out = '';
  const chars = [...value];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (c === '%' && HEX.test((chars[i + 1] ?? '') + (chars[i + 2] ?? ''))) {
      out += c;
    } else if (ALLOWED.test(c)) {
      out += c;
    } else {
      for (const byte of strToU8(c)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * The name to show a person — escapes decoded back to the letters they stand for (`%EC%84%A4` → `설`).
 * Text that is not a valid escape sequence is returned as it is, never thrown on.
 */
export function decodeUriPath(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The part a File value or thumbnail path names inside the package — `file:///x` → `/x`, `./x` → `/x` */
function partOf(value: string): string {
  return resolveTarget(value.replace(/^file:\/\//i, ''), '/');
}

/**
 * Rewrites every File/value and Resource/path (thumbnail) that is not a URI into its percent-encoded form, and renames
 * the part it points to. Returns the input itself when nothing needs it.
 *
 * Important: a value is left alone (and the version check still refuses it) when its encoded form is still not a URI
 *    or when the renamed part would collide with another part — renaming over an existing part loses a file.
 */
export function encodePackagePaths(pkg: AasxPackage): { pkg: AasxPackage; renamed: RenamedPath[] } {
  const hits = scanFeatures(pkg.environment).filter((h) => h.code === 'path-not-uri' && typeof h.value === 'string');
  if (hits.length === 0) return { pkg, renamed: [] };

  const names = new Set<string>([
    ...(pkg.thumbnail ? [pkg.thumbnail.part] : []),
    ...pkg.supplementaryFiles.map((f) => f.part),
    ...pkg.extraParts.keys(),
  ]);
  const partRenames = new Map<string, string>();
  const renamed: RenamedPath[] = [];
  for (const hit of hits) {
    const from = hit.value as string;
    const to = encodeUriPath(from);
    if (to === from || !URI_REFERENCE_PATTERN.test(to)) continue;
    const oldPart = partOf(from);
    const newPart = partOf(to);
    const entry: RenamedPath = { pointer: hit.pointer, field: hit.field, from, to };
    if (names.has(oldPart)) {
      const already = partRenames.get(oldPart);
      if (already === undefined && names.has(newPart)) continue;
      if (already !== undefined && already !== newPart) continue;
      partRenames.set(oldPart, newPart);
      entry.part = { from: oldPart, to: newPart };
    }
    renamed.push(entry);
  }
  if (renamed.length === 0) return { pkg, renamed };

  // A JSON copy keeps key order, so the untouched parts of the body serialize exactly as before
  const environment = JSON.parse(JSON.stringify(pkg.environment)) as Environment;
  for (const r of renamed) setAtPointer(environment, r.pointer, r.to);

  const rename = (file: AasxFile): AasxFile => {
    const to = partRenames.get(file.part);
    return to === undefined ? file : { ...file, part: to };
  };
  const extraParts = new Map<string, Uint8Array>();
  for (const [part, data] of pkg.extraParts) extraParts.set(partRenames.get(part) ?? part, data);
  const out: AasxPackage = {
    ...pkg,
    environment,
    supplementaryFiles: pkg.supplementaryFiles.map(rename),
    extraParts,
  };
  if (pkg.thumbnail) out.thumbnail = rename(pkg.thumbnail);
  return { pkg: out, renamed };
}
