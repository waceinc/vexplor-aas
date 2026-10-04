/**
 * 압축 폭탄·경로 탈출 방어 — 기획서 Ⅷ 보안 항목.
 *
 * 업로드를 받는 서비스라 이 둘은 가정이 아니라 실제 공격면이다.
 * 핵심은 **압축을 풀기 전에 막는 것**이다. 풀고 나서 재는 검사는 이미 늦다.
 */
import { AasxLimitError, isSafeEntryName, readAasx, DEFAULT_LIMITS } from '@aas/aasx';
import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx'));

/** 잘 압축되는(=폭탄에 쓰이는) 데이터 */
function zeros(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe('경로 탈출(Zip Slip)', () => {
  it('상위 경로·절대경로·드라이브 문자·널바이트를 막는다', () => {
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

  it('탈출 경로가 든 AASX는 읽지 않는다', () => {
    const zip = zipSync({
      '[Content_Types].xml': strToU8('<Types />'),
      '../탈출.json': strToU8('{}'),
    });
    expect(() => readAasx(zip)).toThrow(AasxLimitError);
    expect(() => readAasx(zip)).toThrow(/안전하지 않은 파트 경로/);
  });
});

describe('압축 폭탄(Zip Bomb)', () => {
  it('풀었을 때 전체 크기 상한을 넘으면 거부한다', () => {
    // 1MB의 0은 1KB 남짓으로 압축된다 — 전형적인 폭탄의 축소판
    const zip = zipSync({ 'aasx/big.bin': zeros(1024 * 1024) });
    expect(zip.length).toBeLessThan(20 * 1024); // 실제로 잘 압축됐는지 확인

    expect(() => readAasx(zip, { limits: { maxTotalUncompressedBytes: 64 * 1024 } })).toThrow(
      /압축 폭탄일 수 있습니다/,
    );
  });

  it('파트 하나가 상한을 넘어도 거부한다', () => {
    const zip = zipSync({ 'aasx/big.bin': zeros(512 * 1024) });
    expect(() =>
      readAasx(zip, { limits: { maxEntryUncompressedBytes: 128 * 1024 } }),
    ).toThrow(/파트 하나가 상한을 넘었습니다/);
  });

  it('작은 파일을 잔뜩 넣는 수법도 막는다', () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) many[`aasx/f${i}.bin`] = strToU8('x');
    expect(() => readAasx(zipSync(many), { limits: { maxEntries: 10 } })).toThrow(
      /파트 개수가 상한/,
    );
  });

  it('상한 안이면 평소처럼 읽는다 — 방어가 정상 파일을 막으면 안 된다', () => {
    const pkg = readAasx(golden);
    expect(pkg.environment.submodels).toHaveLength(7);

    // 골든 파일은 기본 상한에 한참 못 미친다
    const total = [...pkg.extraParts.values()].reduce((sum, part) => sum + part.length, 0);
    expect(total).toBeLessThan(DEFAULT_LIMITS.maxTotalUncompressedBytes);
  });

  it('기본 상한은 매뉴얼이 든 실물 AASX를 감당할 만큼 넉넉하다', () => {
    // 기획서 Ⅷ: 매뉴얼 PDF가 들어가면 수백 MB가 된다
    expect(DEFAULT_LIMITS.maxTotalUncompressedBytes).toBeGreaterThanOrEqual(512 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxEntries).toBeGreaterThanOrEqual(1000);
  });
});
