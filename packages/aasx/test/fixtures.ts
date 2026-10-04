import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

/** 골든 파일 — KOSMO Validator 전 항목 Passed 확인분 */
export const GOLDEN = '01-롤포밍기-공34.aasx';

/** 회귀 픽스처 (설비 20종 중 대표 3종) */
export const FIXTURES = [GOLDEN, '03-SPR장비-뿌80.aasx', '11-협동로봇6축.aasx'] as const;

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(root + name));
}
