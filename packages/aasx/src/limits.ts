/**
 * Zip Bomb and Zip Slip (path traversal) defenses — spec VIII security item.
 *
 * This is a real risk from the moment we accept uploads. Fortunately fflate's `unzipSync` **allocates the output buffer
 * only up to the original size declared in the central directory (`originalSize`)** (`inflateSync(..., { out: new u8(su) })`).
 * So **blocking in the filter before decompression rules out memory blow-up entirely** — even if the header lies,
 * nothing beyond that size is allocated, and inflate fails on its own if the stream overflows.
 *
 * Paths stay in memory only for now, but once **a code path that writes to disk appears** (re-saving, extracting attachments),
 * **it is too late by then.** So we block them once at the read site.
 */
import { fill, tr } from '@aas/core';

export interface AasxLimits {
  /** Upper limit on total uncompressed size. Default 512MB — sized for AASX files that contain manuals (spec VIII) */
  maxTotalUncompressedBytes: number;
  /** Upper limit per part. Default 256MB */
  maxEntryUncompressedBytes: number;
  /** Upper limit on part count. Blocks inflation via hundreds of thousands of tiny files */
  maxEntries: number;
}

export const DEFAULT_LIMITS: AasxLimits = {
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
};

/** A limit was exceeded or a path is dangerous. Distinct from file format errors (AasxReadError) */
export class AasxLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AasxLimitError';
  }
}

/**
 * Whether a ZIP entry name is safe.
 *
 * Blocks: parent traversal (`..`), absolute paths, drive letters (`C:`), UNC (`//server`), null bytes.
 * Backslashes are treated like slashes because they are path separators on Windows.
 */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

/**
 * Filter passed to unzipSync. Decides **before** decompression.
 * Throws and stops immediately when a limit is exceeded — continuing to extract the rest is itself the danger.
 */
export function createEntryGuard(limits: AasxLimits): (file: {
  name: string;
  originalSize: number;
}) => boolean {
  let total = 0;
  let count = 0;

  return (file) => {
    if (!isSafeEntryName(file.name)) {
      throw new AasxLimitError(fill(tr('안전하지 않은 파트 경로입니다: {0}'), { 0: file.name }));
    }

    count += 1;
    if (count > limits.maxEntries) {
      throw new AasxLimitError(fill(tr('파트 개수가 상한({0}개)을 넘었습니다.'), { 0: limits.maxEntries }));
    }

    if (file.originalSize > limits.maxEntryUncompressedBytes) {
      throw new AasxLimitError(
        fill(tr('파트 하나가 상한을 넘었습니다: {0} — {1}바이트 (상한 {2})'), {
          0: file.name,
          1: file.originalSize,
          2: limits.maxEntryUncompressedBytes,
        }),
      );
    }

    total += file.originalSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new AasxLimitError(
        fill(tr('풀었을 때 크기가 상한({0}바이트)을 넘었습니다. 압축 폭탄일 수 있습니다.'), {
          0: limits.maxTotalUncompressedBytes,
        }),
      );
    }

    return true;
  };
}
