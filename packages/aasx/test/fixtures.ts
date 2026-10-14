import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

/** Golden file — confirmed Passed on every KOSMO Validator item */
export const GOLDEN = '01-roll-forming-machine.aasx';

/** Regression fixtures (3 representative of the 20 equipment types) */
export const FIXTURES = [GOLDEN, '03-spr-riveting-machine.aasx', '11-cobot-6-axis.aasx'] as const;

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(root + name));
}
