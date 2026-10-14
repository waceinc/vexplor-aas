/**
 * Appends a translation batch to the end of the English dictionary (apps/web/src/en.ts) — a helper for translation work.
 *
 *     node scripts/i18n-append.mjs <batch.txt>
 *
 * The batch holds the dictionary lines verbatim (`'key': 'translation',`). Before appending, **keys that already
 * exist** are filtered out — a duplicate key makes TypeScript stop the build with TS1117 (this happened twice before).
 */
import { parse } from '@babel/parser';
import { readFileSync, writeFileSync } from 'node:fs';

import { dictionary } from './i18n-scan.mjs';

const TARGET = 'apps/web/src/en.ts';
const batch = readFileSync(process.argv[2], 'utf8');

// Parse the batch as an object to extract keys — splitting by line would break two-line entries
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
  // Copy the source text verbatim (quotes and line breaks are not regenerated). Offsets are shifted by the `({` prefix
  keep.push({ start: property.start - 2, end: property.end - 2 });
}

// Keep the batch's comments (screen names) too — take the text between entries as a whole
let out = '';
let cursor = 0;
for (const item of keep) {
  const lead = batch.slice(cursor, item.start);
  // Drop the text of skipped entries and keep only comment lines
  const comments = lead.split('\n').filter((line) => line.trim().startsWith('//')).join('\n');
  out += `${comments ? `\n${comments}` : ''}\n  ${batch.slice(item.start, item.end)},`;
  cursor = item.end;
}

const code = readFileSync(TARGET, 'utf8');
const at = code.lastIndexOf('};');
writeFileSync(TARGET, `${code.slice(0, at).replace(/\s+$/, '\n')}${out}\n};\n`);
console.log(`${keep.length}개를 붙였다${skipped > 0 ? ` · 이미 있어서 건너뜀 ${skipped}개` : ''}.`);
