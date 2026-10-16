/**
 * AASX writing — spec M2.
 *
 * Always updates all three places together: parts, relationships and Content_Types (PKG-THUMB-PART).
 * Follows the same relationship ID rule as the golden file (01 roll-forming machine): origin=r1, thumbnail=r3, spec=r0.
 */
import { serializeEnvironment } from '@aas/core';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  buildContentTypes,
  buildRelationships,
  guessContentType,
  RELS_CONTENT_TYPE,
  REL_TYPE,
  relsPathFor,
  toEntryName,
  type ContentTypes,
  type Relationship,
} from './opc.js';
import { ORIGIN_PART, type AasxPackage } from './package.js';

export interface WriteOptions {
  /** data.json indentation. Default 2 */
  indent?: number;
  /**
   * ZIP entry modification time (Unix epoch ms). Setting it makes the output deterministic.
   * The default is fixed for regression tests and CI reproducibility.
   */
  mtime?: number;
  /** Compression level 0-9. Default 6 */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** Default timestamp for deterministic output (2026-01-01T00:00:00Z) */
export const DETERMINISTIC_MTIME = 1767225600000;

/**
 * The ZIP entry time for `mtime`, the same on every machine.
 * Important: ZIP keeps a local DOS date and time, and fflate fills it from the Date's **local** fields. The same content
 *    written in Seoul and on a UTC server therefore gave different bytes — the sample integration bundle's hash differed
 *    between a developer machine and CI (2026-10-16). A Date whose local fields are the UTC fields of `mtime` makes every
 *    machine write the UTC wall clock.
 */
export function zipTime(mtime: number): Date {
  const utc = new Date(mtime);
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
    utc.getUTCMilliseconds(),
  );
}

export function writeAasx(pkg: AasxPackage, options: WriteOptions = {}): Uint8Array {
  const { indent = 2, mtime = DETERMINISTIC_MTIME, level = 6 } = options;

  const specPart = pkg.specPart;
  const parts = new Map<string, Uint8Array>();
  const contentTypes: ContentTypes = { defaults: new Map(), overrides: new Map() };

  const addPart = (part: string, data: Uint8Array, contentType: string): void => {
    parts.set(part, data);
    contentTypes.overrides.set(part, contentType);
  };

  // ① AAS body
  addPart(specPart, strToU8(serializeEnvironment(pkg.environment, { indent })), 'application/json');

  // ② origin part (empty — its presence alone marks the file as AASX)
  addPart(ORIGIN_PART, new Uint8Array(0), 'text/plain');

  // ③ Thumbnail and attachments
  const rootRels: Relationship[] = [
    { id: 'r1', type: REL_TYPE.origin, target: ORIGIN_PART, targetMode: 'Internal' },
  ];
  if (pkg.thumbnail) {
    const t = pkg.thumbnail;
    addPart(t.part, t.data, t.contentType || guessContentType(t.part));
    rootRels.push({ id: 'r3', type: REL_TYPE.thumbnail, target: t.part, targetMode: 'Internal' });
  }

  const specRels: Relationship[] = [];
  pkg.supplementaryFiles.forEach((f, i) => {
    addPart(f.part, f.data, f.contentType || guessContentType(f.part));
    specRels.push({
      id: `rs${i}`,
      type: REL_TYPE.suppl,
      target: f.part,
      targetMode: 'Internal',
    });
  });

  // ④ Other preserved parts
  for (const [part, data] of pkg.extraParts) {
    if (parts.has(part)) continue;
    addPart(part, data, guessContentType(part));
  }

  // ⑤ The three relationship files — built after all parts are filled in
  const originRelsPart = relsPathFor(ORIGIN_PART);
  const specRelsPart = relsPathFor(specPart);
  const originRels: Relationship[] = [
    { id: 'r0', type: REL_TYPE.spec, target: specPart, targetMode: 'Internal' },
  ];

  addPart('/_rels/.rels', strToU8(buildRelationships(rootRels)), RELS_CONTENT_TYPE);
  addPart(originRelsPart, strToU8(buildRelationships(originRels)), RELS_CONTENT_TYPE);
  addPart(specRelsPart, strToU8(buildRelationships(specRels)), RELS_CONTENT_TYPE);

  // ⑥ [Content_Types].xml — it does not get an Override for itself
  const ctXml = buildContentTypes(contentTypes);

  const zippable: Zippable = {};
  const opts = { level, mtime: zipTime(mtime) } as const;
  zippable['[Content_Types].xml'] = [strToU8(ctXml), opts];
  for (const [part, data] of parts) {
    zippable[toEntryName(part)] = [data, opts];
  }

  return zipSync(zippable, opts);
}
