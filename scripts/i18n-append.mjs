/**
 * 번역 묶음을 영어 사전(apps/web/src/en.ts)의 끝에 붙인다 — 번역 작업용 보조 도구.
 *
 *     node scripts/i18n-append.mjs <묶음.txt>
 *
 * 묶음은 사전에 들어갈 줄 그대로다(`'열쇠': '번역',`). 붙이기 전에 **이미 있는 열쇠**를 걸러
 * 낸다 — 같은 열쇠가 두 번 들어가면 TypeScript가 TS1117로 빌드를 멈춘다(전에 두 번 겪었다).
 */
import { parse } from '@babel/parser';
import { readFileSync, writeFileSync } from 'node:fs';

import { dictionary } from './i18n-scan.mjs';

const TARGET = 'apps/web/src/en.ts';
const batch = readFileSync(process.argv[2], 'utf8');

// 묶음을 객체로 읽어 열쇠를 꺼낸다 — 줄 단위로 자르면 두 줄짜리 항목이 깨진다
const ast = parse(`({${batch}\n})`, { plugins: ['typescript'] });
const object = ast.program.body[0].expression;
const have = dictionary();
const seen = new Set();
const keep = [];
let skipped = 0;
for (const property of object.properties) {
  const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
  if (have.has(key) || seen.has(key)) {
    skipped += 1;
    continue;
  }
  seen.add(key);
  // 원문 그대로 옮긴다(따옴표·줄바꿈을 다시 만들지 않는다). `({` 3글자만큼 자리가 밀려 있다
  keep.push({ start: property.start - 2, end: property.end - 2 });
}

// 묶음의 주석(화면 이름)도 살린다 — 항목 사이의 글을 통째로 가져온다
let out = '';
let cursor = 0;
for (const item of keep) {
  const lead = batch.slice(cursor, item.start);
  // 건너뛴 항목의 글은 버리고, 주석 줄만 남긴다
  const comments = lead.split('\n').filter((line) => line.trim().startsWith('//')).join('\n');
  out += `${comments ? `\n${comments}` : ''}\n  ${batch.slice(item.start, item.end)},`;
  cursor = item.end;
}

const code = readFileSync(TARGET, 'utf8');
const at = code.lastIndexOf('};');
writeFileSync(TARGET, `${code.slice(0, at).replace(/\s+$/, '\n')}${out}\n};\n`);
console.log(`${keep.length}개를 붙였다${skipped > 0 ? ` · 이미 있어서 건너뜀 ${skipped}개` : ''}.`);
