/**
 * Writes the license into every package.json.
 *
 *     node scripts/set-license.mjs
 *
 * Important: `private: true` is **left as-is.** It does not mean "proprietary software" but
 *    "not published to the npm registry". This repository is an application deployed as a whole, not a
 *    library, so preventing an accidental `npm publish` is the right call.
 *
 * The field is inserted right after `version` to keep key order — rewriting the JSON wholesale would
 * change the hand-arranged order and make the diff noisy.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const LICENSE = 'Apache-2.0';
const files = [
  'package.json',
  ...readdirSync('packages').map((name) => `packages/${name}/package.json`),
  ...readdirSync('apps').map((name) => `apps/${name}/package.json`),
];

for (const file of files) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.license === LICENSE) {
    console.log(`unchanged  ${file}`);
    continue;
  }
  const ordered = {};
  let placed = false;
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'license') continue;
    ordered[key] = value;
    if (key === 'version') {
      ordered.license = LICENSE;
      placed = true;
    }
  }
  if (!placed) ordered.license = LICENSE;
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`written    ${file}`);
}
