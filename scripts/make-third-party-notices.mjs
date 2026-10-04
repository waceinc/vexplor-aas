/**
 * 의존성의 라이선스를 모아 THIRD-PARTY-NOTICES.md를 만든다.
 *
 *     node scripts/make-third-party-notices.mjs          # 파일을 쓴다
 *     node scripts/make-third-party-notices.mjs --check  # 쓰지 않고 판정만 (CI용)
 *
 * 🔴 **실행에 딸려 가는 것**(런타임)에 카피레프트(GPL·LGPL·AGPL)가 있으면 종료코드 1.
 *    Apache-2.0으로 내놓은 프로그램에 그런 것이 섞이면 받는 사람이 조건을 지킬 수 없다.
 *    OPC UA를 Python(asyncua, LGPL-3.0)이 아니라 node-opcua(MIT)로 고른 이유가 이것이고,
 *    의존성은 언제든 바뀌므로 **사람의 기억이 아니라 검사로** 지킨다.
 *
 * 근거는 package-lock.json이다 — 실제로 깔리는 판과 라이선스가 거기 적혀 있다.
 * 개발용(시험·빌드 도구)은 배포물에 들어가지 않으므로 목록만 싣고 판정하지 않는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const checkOnly = process.argv.includes('--check');

/** 받는 사람에게 소스 공개 의무를 지우는 것들 */
const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|CC-BY-SA|CC-BY-NC)\b/i;

/**
 * package.json에 라이선스를 **적지 않은** 꾸러미 — 사람이 직접 열어 확인한 결과다.
 *
 * 🔴 「아마 MIT겠지」로 채우지 않는다. 꾸러미 안의 파일을 읽고 근거를 함께 적는다.
 *    판이 바뀌면 다시 확인해야 하므로 **판 번호까지** 맞을 때만 쓴다.
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
  // 뿌리와 우리 워크스페이스(packages/*, apps/*)는 제3자가 아니다
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
