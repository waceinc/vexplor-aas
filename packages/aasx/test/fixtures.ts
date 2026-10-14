import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

/** Golden file — confirmed Passed on every KOSMO Validator item */
export const GOLDEN = '01-롤포밍기-공34.aasx';

/** Regression fixtures (3 representative of the 20 equipment types) */
export const FIXTURES = [GOLDEN, '03-SPR장비-뿌80.aasx', '11-협동로봇6축.aasx'] as const;

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(root + name));
}
