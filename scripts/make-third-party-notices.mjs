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
  'dequeue@1.0.5': { license: 'BSD-2-Clause', evidence: 'LICENSE 파일 — "This is the 2-Clause BSD license"' },
  'humanize@0.0.9': { license: 'MIT', evidence: 'LICENSE 파일 — MIT 전문 (Copyright (c) 2012 Tai-Jin Lee)' },
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
  target.set(key, { name, version: entry.version, license: license ?? '(적혀 있지 않음)' });
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
  '# 제3자 소프트웨어 고지 (Third-Party Notices)',
  '',
  '이 프로그램은 아래 오픈소스에 기대어 동작합니다. 각 소프트웨어의 저작권은 그 저작자에게 있고,',
  '적힌 라이선스에 따라 쓰입니다. 전문은 설치 뒤 `node_modules/<이름>/LICENSE`에서 볼 수 있습니다.',
  '',
  '> 이 파일은 `node scripts/make-third-party-notices.mjs`가 `package-lock.json`에서 만듭니다.',
  '> 손으로 고치지 마십시오 — 의존성을 바꾼 뒤 다시 만드십시오.',
  '',
  '## 요약',
  '',
  `- 실행에 딸려 가는 것(런타임): **${runtime.size}개**`,
  `- 개발·시험에만 쓰는 것: ${development.size}개 (배포물에 들어가지 않습니다)`,
  `- 런타임의 카피레프트(GPL·LGPL·AGPL): **${blocked.length}개**`,
  '',
  '| 런타임 라이선스 | 개수 |',
  '|---|---|',
  ...tally(runtime).map(([license, count]) => `| ${license} | ${count} |`),
  '',
  '## 런타임',
  '',
  '| 이름 | 판 | 라이선스 |',
  '|---|---|---|',
  ...sorted(runtime).map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  '### 라이선스를 직접 확인한 것',
  '',
  '`package.json`에 라이선스가 적혀 있지 않아 꾸러미 안의 파일을 열어 확인했습니다.',
  '',
  '| 이름 | 라이선스 | 근거 |',
  '|---|---|---|',
  ...Object.entries(VERIFIED).map(([key, item]) => `| ${key} | ${item.license} | ${item.evidence} |`),
  '',
  '## 개발·시험용',
  '',
  '| 이름 | 판 | 라이선스 |',
  '|---|---|---|',
  ...sorted(development).map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  '## 그 밖의 자료',
  '',
  '- `docs/spec/part2/*.yaml` — IDTA-01002-3-0 (Specification of the Asset Administration Shell,',
  '  Part 2: API). Industrial Digital Twin Association 발행, **CC BY 4.0**.',
  '',
];

console.log(`런타임 ${runtime.size}개 · 개발용 ${development.size}개`);
for (const [license, count] of tally(runtime)) console.log(`  ${String(count).padStart(4)}  ${license}`);

if (runtimeUnknown.length > 0) {
  console.log(`\n⚠️  런타임인데 라이선스가 적혀 있지 않은 것 ${runtimeUnknown.length}개 — 직접 확인이 필요합니다:`);
  for (const item of runtimeUnknown) console.log(`   ${item.key}`);
}
if (blocked.length > 0) {
  console.log(`\n🔴 런타임에 카피레프트가 있습니다 — Apache-2.0으로 내놓을 수 없습니다:`);
  for (const item of blocked) console.log(`   ${item.name}@${item.version}  ${item.license}`);
}

if (!checkOnly) {
  writeFileSync('THIRD-PARTY-NOTICES.md', `${lines.join('\n')}`);
  console.log('\nTHIRD-PARTY-NOTICES.md를 썼습니다.');
}
process.exit(blocked.length > 0 ? 1 : 0);
