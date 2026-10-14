/**
 * Finds **Korean text that bypasses the translator** in server code — linter findings, rule descriptions,
 * reports, bundle READMEs, API errors. Uses the same parser and conventions as the UI side (i18n-scan.mjs).
 *
 *     node scripts/i18n-server-scan.mjs                 # count per file
 *     node scripts/i18n-server-scan.mjs --list          # every occurrence
 *     node scripts/i18n-server-scan.mjs --keys          # routed through tr() but missing from the English dictionary
 *     node scripts/i18n-server-scan.mjs --only packages/linter/src/rules   # narrow by path
 *     node scripts/i18n-server-scan.mjs --check         # exit code 1 if anything remains (for CI)
 *
 * Dictionary = packages/aas-core/src/i18n/en/*.ts (split by area so several translators working at once do not collide in one file).
 *
 * Places where Korean belongs are excluded with `// i18n-ignore — reason` (that line and the next). E.g. values fixed by
 * a spec, such as folder names in a submission bundle, or values compared against text the server received. Without a
 * reason the next person does not know why it was excluded.
 */
import { parse } from '@babel/parser';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanFile, marks } from './i18n-scan.mjs';

const HANGUL = /[가-힣]/;

/** Where server text lives — the UI (apps/web) is covered by i18n-scan.mjs */
const ROOTS = [
  'packages/aas-core/src',
  'packages/aasx/src',
  'packages/linter/src',
  'packages/store/src',
  'packages/collector/src',
  'packages/opcua/src',
  'packages/fieldbus/src',
  'apps/api/src',
];
/** The dictionary itself and the translation machinery */
const EXEMPT = ['packages/aas-core/src/i18n/'];
const DICT_DIR = 'packages/aas-core/src/i18n/en';

function walkFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walkFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

export function serverFiles() {
  return ROOTS.filter((root) => existsSync(root))
    .flatMap((root) => walkFiles(root))
    .map((file) => file.split('\\').join('/'))
    .filter((file) => !EXEMPT.some((prefix) => file.startsWith(prefix)));
}

/** Server English dictionary — extracted by parsing the files, not executing them. Reports a key that appears in two files */
export function serverDictionary() {
  const found = new Map();
  const duplicates = [];
  for (const name of readdirSync(DICT_DIR).filter((n) => n.endsWith('.ts')).sort()) {
    const code = readFileSync(join(DICT_DIR, name), 'utf8');
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'VariableDeclarator' && node.init) {
        const object = ['TSAsExpression', 'TSSatisfiesExpression'].includes(node.init.type) ? node.init.expression : node.init;
        if (object.type === 'ObjectExpression') {
          for (const property of object.properties) {
            if (property.type !== 'ObjectProperty') continue;
            const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
            const value = property.value.type === 'StringLiteral' ? property.value.value
              : property.value.type === 'TemplateLiteral' ? property.value.quasis.map((q) => q.value.cooked).join('') : undefined;
            if (found.has(key)) duplicates.push({ key, file: name });
            found.set(key, value);
          }
          return;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast.program);
  }
  return { dict: found, duplicates };
}

// ── Command line ────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('i18n-server-scan.mjs')) {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const showKeys = args.includes('--keys');
  const check = args.includes('--check');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;
  const { dict, duplicates } = serverDictionary();

  let total = 0;
  const missing = new Map();
  const rows = [];
  for (const file of serverFiles()) {
    if (only && !file.startsWith(only)) continue;
    const { untranslated, keys } = scanFile(file);
    total += untranslated.length;
    for (const key of keys) {
      if (HANGUL.test(key.text) && !dict.has(key.text)) missing.set(key.text, `${file}:${key.line}`);
    }
    if (untranslated.length > 0) rows.push({ file, untranslated });
  }

  const broken = [];
  for (const [key, value] of dict) {
    if (value === undefined || value === '' && HANGUL.test(key)) broken.push({ key, value: String(value) });
    else if (marks(key) !== marks(value)) broken.push({ key, value });
    else if (HANGUL.test(value)) broken.push({ key, value }); // Korean left in the English slot
  }

  rows.sort((a, b) => b.untranslated.length - a.untranslated.length);
  for (const row of rows) {
    console.log(`${String(row.untranslated.length).padStart(5)}  ${row.file}`);
    if (list) for (const item of row.untranslated) console.log(`         ${item.line}  [${item.kind}] ${item.text.slice(0, 110)}`);
  }
  console.log(`
[서버] 번역기를 거치지 않는 한국어: ${total}곳`);
  console.log(`[서버] 번역기를 거치지만 영어 사전에 없는 것: ${missing.size}개 (사전 ${dict.size}항목)`);
  console.log(`[서버] 번역문이 비었거나 표시({0} · <b>)가 원문과 다르거나 한국어가 남은 것: ${broken.length}개`);
  console.log(`[서버] 두 사전 파일에 같은 열쇠: ${duplicates.length}개`);
  if (showKeys) for (const [text, where] of missing) console.log(`   ${where}  ${text.slice(0, 120)}`);
  for (const item of broken.slice(0, 20)) console.log(`   [FAIL] ${item.key.slice(0, 70)}\n      → ${String(item.value).slice(0, 70)}`);
  for (const item of duplicates.slice(0, 20)) console.log(`   [FAIL] 겹친 열쇠 (${item.file}) ${item.key.slice(0, 70)}`);

  if (check && (total > 0 || missing.size > 0 || broken.length > 0 || duplicates.length > 0)) process.exit(1);
}
