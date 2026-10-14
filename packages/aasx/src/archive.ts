/**
 * **Plain ZIP**, not AASX — for reference bundle packages.
 *
 * AASX is a ZIP with OPC conventions (Content_Types, relationships), so it has its own readAasx/writeAasx.
 * A bundle is an ordinary ZIP holding several AASX files plus documents and spreadsheets in folders. It uses the same fflate,
 * but applies **the same zip-bomb and path-traversal defenses as AASX** (spec VIII) — bundles are also files supplied by others.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { fill, tr } from '@aas/core';
import { AasxLimitError, createEntryGuard, DEFAULT_LIMITS, type AasxLimits } from './limits.js';
import { DETERMINISTIC_MTIME } from './write.js';

export class ArchiveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveReadError';
  }
}

/**
 * Packs path -> bytes into a ZIP. Paths are separated by `/`.
 * The modification time is fixed so that **the same content yields the same bytes** — bundle hashes must be reproducible.
 */
export function zipArchive(files: Record<string, Uint8Array>, mtime = DETERMINISTIC_MTIME): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    // Do not recompress already-compressed AASX — it only costs time
    zippable[path] = [data, { level: /\.(aasx|zip|png|jpe?g)$/i.test(path) ? 0 : 6, mtime }];
  }
  return zipSync(zippable, { mtime });
}

/** Unzips. Limits and dangerous paths are blocked before extraction. Directory entries are skipped */
export function unzipArchive(buffer: Uint8Array, limits: Partial<AasxLimits> = {}): Record<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer, { filter: createEntryGuard({ ...DEFAULT_LIMITS, ...limits }) });
  } catch (e) {
    if (e instanceof AasxLimitError) throw e;
    throw new ArchiveReadError(fill(tr('ZIP을 열 수 없습니다: {0}'), { 0: (e as Error).message }));
  }
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('/')) out[name] = data;
  }
  return out;
}
