/**
 * Collects dependency licenses and generates THIRD-PARTY-NOTICES.md.
 *
 *     node scripts/make-third-party-notices.mjs          # write the file
 *     node scripts/make-third-party-notices.mjs --check  # verdict only, no write (for CI)
 *
 * Important: exit code 1 if anything **shipped for execution** (runtime) is copyleft (GPL, LGPL, AGPL).
 *    If such code is mixed into a program released under Apache-2.0, recipients cannot meet its terms.
 *    This is why OPC UA uses node-opcua (MIT) rather than Python (asyncua, LGPL-3.0), and since dependencies
 *    can change at any time, this is enforced **by a check, not by people's memory**.
 *
 * The source of truth is package-lock.json — it records the versions actually installed and their licenses.
 * Development-only packages (test and build tools) do not ship, so they are listed but not judged.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const checkOnly = process.argv.includes('--check');

/** Licenses that impose source-disclosure obligations on recipients */
const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|CC-BY-SA|CC-BY-NC)\b/i;

/**
 * Packages whose package.json **does not state** a license — the result of a person opening and checking them.
 *
 * Important: never fill in "probably MIT". Read the files inside the package and record the evidence.
 *    A new version must be re-checked, so an entry applies only when **the version number** matches too.
 */
const VERIFIED = {
  'dequeue@1.0.5': { license: 'BSD-2-Clause', evidence: 'LICENSE file — "This is the 2-Clause BSD license"' },
  'humanize@0.0.9': { license: 'MIT', evidence: 'LICENSE file — full MIT text (Copyright (c) 2012 Tai-Jin Lee)' },
  'precond@0.2.3': { license: 'MIT', evidence: 'README.md §License — "free to use under the terms of the MIT license"' },
};

const runtime = new Map();
const development = new Map();
const unknown = [];

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  // The root and our workspaces (packages/*, apps/*) are not third-party
  if (!path.includes('node_modules/')) continue;
  if (entry.link) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (name.startsWith('@aas/')) continue;
  const key = `${name}@${entry.version}`;
  const license = typeof entry.license === 'string' ? entry.license : VERIFIED[key]?.license;
  if (!license) unknown.push({ key, dev: entry.dev === true });
  const target = entry.dev === true ? development : runtime;
  target.set(key, { name, version: entry.version, license: license ?? '(not stated)' });
}

const sorted = (map) => [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
const tally = (map) => {
  const counts = {};
  for (const item of map.values()) counts[item.license] = (counts[item.license] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
};

const blocked = sorted(runtime).filter((item) => COPYLEFT.test(item.license));
const runtimeUnknown = unknown.filter((item) => !item.dev);

const lines = [
  '# Third-Party Notices',
  '',
  'This program relies on the open-source software listed below. Each package is copyrighted by its authors',
  'and used under the license shown. Full license texts are in `node_modules/<name>/LICENSE` after installation.',
  '',
  '> This file is generated from `package-lock.json` by `node scripts/make-third-party-notices.mjs`.',
  '> Do not edit it by hand — regenerate it after changing dependencies.',
  '',
  '## Summary',
  '',
  `- Shipped for execution (runtime): **${runtime.size}**`,
  `- Development and testing only: ${development.size} (not included in releases)`,
  `- Copyleft at runtime (GPL, LGPL, AGPL): **${blocked.length}**`,
  '',
  '| Runtime license | Count |',
  '|---|---|',
  ...tally(runtime).map(([license, count]) => `| ${license} | ${count} |`),
  '',
  '## Runtime',
  '',
  '| Name | Version | License |',
  '|---|---|---|',
  ...sorted(runtime).map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  '### Licenses verified by hand',
  '',
  'These packages do not state a license in `package.json`, so the files inside the package were opened and checked.',
  '',
  '| Name | License | Evidence |',
  '|---|---|---|',
  ...Object.entries(VERIFIED).map(([key, item]) => `| ${key} | ${item.license} | ${item.evidence} |`),
  '',
  '## Development and testing',
  '',
  '| Name | Version | License |',
  '|---|---|---|',
  ...sorted(development).map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  '## Other material',
  '',
  '- `docs/spec/part2/*.yaml` — IDTA-01002-3-0 (Specification of the Asset Administration Shell,',
  '  Part 2: API). Published by the Industrial Digital Twin Association, **CC BY 4.0**.',
  '',
];

console.log(`Runtime ${runtime.size} · development ${development.size}`);
for (const [license, count] of tally(runtime)) console.log(`  ${String(count).padStart(4)}  ${license}`);

if (runtimeUnknown.length > 0) {
  console.log(`\n[WARN] ${runtimeUnknown.length} runtime packages state no license — check them by hand:`);
  for (const item of runtimeUnknown) console.log(`   ${item.key}`);
}
if (blocked.length > 0) {
  console.log(`\n[FAIL] Copyleft at runtime — cannot be released under Apache-2.0:`);
  for (const item of blocked) console.log(`   ${item.name}@${item.version}  ${item.license}`);
}

if (!checkOnly) {
  writeFileSync('THIRD-PARTY-NOTICES.md', `${lines.join('\n')}`);
  console.log('\nWrote THIRD-PARTY-NOTICES.md.');
}
process.exit(blocked.length > 0 ? 1 : 0);
