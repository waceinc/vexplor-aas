/**
 * Zip bomb and path traversal defence — plan document section VIII (security).
 *
 * The service accepts uploads, so both are a real attack surface, not a hypothetical.
 * The key is **blocking before decompression**. A check measured after extracting is already too late.
 */
import { AasxLimitError, isSafeEntryName, readAasx, DEFAULT_LIMITS } from '@aas/aasx';
import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = new Uint8Array(readFileSync(root + '01-roll-forming-machine.aasx'));

/** Highly compressible data (= the kind used in bombs) */
function zeros(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe('Path traversal (Zip Slip)', () => {
  it('blocks parent paths, absolute paths, drive letters and null bytes', () => {
    expect(isSafeEntryName('aasx/data.json')).toBe(true);
    expect(isSafeEntryName('[Content_Types].xml')).toBe(true);

    expect(isSafeEntryName('../evil.json')).toBe(false);
    expect(isSafeEntryName('aasx/../../etc/passwd')).toBe(false);
    expect(isSafeEntryName('/etc/passwd')).toBe(false);
    expect(isSafeEntryName('C:\\Windows\\system32')).toBe(false);
    expect(isSafeEntryName('aasx\\..\\..\\evil')).toBe(false);
    expect(isSafeEntryName('bad\0name')).toBe(false);
    expect(isSafeEntryName('')).toBe(false);
  });

  it('refuses to read an AASX containing an escaping path', () => {
    const zip = zipSync({
      '[Content_Types].xml': strToU8('<Types />'),
      '../탈출.json': strToU8('{}'),
    });
    expect(() => readAasx(zip)).toThrow(AasxLimitError);
    expect(() => readAasx(zip)).toThrow(/안전하지 않은 파트 경로/);
  });
});

describe('Zip bomb', () => {
  it('rejects when the total extracted size exceeds the limit', () => {
    // 1 MB of zeros compresses to about 1 KB — a miniature of a typical bomb
    const zip = zipSync({ 'aasx/big.bin': zeros(1024 * 1024) });
    expect(zip.length).toBeLessThan(20 * 1024); // confirm it actually compressed well

    expect(() => readAasx(zip, { limits: { maxTotalUncompressedBytes: 64 * 1024 } })).toThrow(
      /압축 폭탄일 수 있습니다/,
    );
  });

  it('rejects when a single part exceeds the limit', () => {
    const zip = zipSync({ 'aasx/big.bin': zeros(512 * 1024) });
    expect(() =>
      readAasx(zip, { limits: { maxEntryUncompressedBytes: 128 * 1024 } }),
    ).toThrow(/파트 하나가 상한을 넘었습니다/);
  });

  it('also blocks the many-tiny-files trick', () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) many[`aasx/f${i}.bin`] = strToU8('x');
    expect(() => readAasx(zipSync(many), { limits: { maxEntries: 10 } })).toThrow(
      /파트 개수가 상한/,
    );
  });

  it('reads normally within the limits — the defence must not block valid files', () => {
    const pkg = readAasx(golden);
    expect(pkg.environment.submodels).toHaveLength(7);

    // The golden file is far below the default limits
    const total = [...pkg.extraParts.values()].reduce((sum, part) => sum + part.length, 0);
    expect(total).toBeLessThan(DEFAULT_LIMITS.maxTotalUncompressedBytes);
  });

  it('default limits are generous enough for real AASX files that include manuals', () => {
    // Plan document VIII: with manual PDFs inside, files reach hundreds of MB
    expect(DEFAULT_LIMITS.maxTotalUncompressedBytes).toBeGreaterThanOrEqual(512 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxEntries).toBeGreaterThanOrEqual(1000);
  });
});
