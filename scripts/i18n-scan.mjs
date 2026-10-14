/**
 * Finds **Korean text that bypasses the translator** in the web UI code.
 *
 *     node scripts/i18n-scan.mjs              # count per file
 *     node scripts/i18n-scan.mjs --list       # every occurrence
 *     node scripts/i18n-scan.mjs --keys       # translator-routed text missing from the English dictionary
 *     node scripts/i18n-scan.mjs --check      # exit code 1 if either remains (for CI)
 *
 * Why a tool: the English UI was stuck at "skeleton only" for a long time. Fixing by eye only fixes what you
 * happen to see, and every new screen leaks again. A **counting tool** gives the work an end and keeps it done.
 *
 * What is counted (comments are not scanned — they must be in English anyway, CONTRIBUTING rule 5)
 *   - JSX text                     <p>저장했습니다</p>
 *   - text attributes              title="…" placeholder="…" aria-label="…"
 *   - strings/templates in exprs   setError('…') · `위반 ${n}건`
 * Arguments of translator calls are not counted:  t('…') · tr('…') · fill(tr('…'), …)
 *
 * Important: read with a **parser**, not regexes. While anonymizing test fixtures, a regex scan over JSON got
 *    its quote pairing flipped and missed a real company name. A search tool that silently misses is the worst kind.
 */
import { parse } from '@babel/parser';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'apps/web/src';
const HANGUL = /[가-힣]/;
/** Translators — the first argument of these functions is a dictionary key */
const TRANSLATORS = new Set(['t', 'tr']);

/** Places where Korean belongs — not translation targets */
const EXEMPT_FILES = new Set([
  'i18n.ts', // the dictionary itself
  'en.ts', // the dictionary itself
]);

export function sourceFiles(dir = ROOT) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/** Reads one file and returns { untranslated, keys } */
export function scanFile(file) {
  const code = readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], ranges: false });
  const untranslated = [];
  const keys = [];
  // `// i18n-ignore` — that line and the **next line** hold values, not UI text (e.g. font names).
  // A reason must be written next to it: a bare marker leaves the next person not knowing why it was excluded
  const ignored = new Set();
  for (const comment of ast.comments ?? []) {
    if (!comment.value.includes('i18n-ignore')) continue;
    for (let line = comment.loc.start.line; line <= comment.loc.end.line + 1; line += 1) ignored.add(line);
  }

  const isTranslatorCall = (node) =>
    node?.type === 'CallExpression' && node.callee.type === 'Identifier' && TRANSLATORS.has(node.callee.name);

  const report = (node, text, kind) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!HANGUL.test(clean)) return;
    if (ignored.has(node.loc.start.line)) return;
    untranslated.push({ line: node.loc.start.line, kind, text: clean, start: node.start, end: node.end });
  };

  /** Walk down carrying the parent — the parent is needed to tell whether a node is a translator argument */
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;

    // Strings in type positions ('admin' | 'editor') are not UI text
    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSSatisfiesExpression') {
      return;
    }

    // <T k="…" /> — whole-sentence translation. k is the dictionary key
    if (node.type === 'JSXAttribute' && node.name.name === 'k' && parent?.name?.name === 'T') {
      const value = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value;
      if (value?.type === 'StringLiteral') keys.push({ line: node.loc.start.line, text: value.value });
      return;
    }

    if (node.type === 'JSXText') {
      report(node, node.value, 'jsx');
    } else if (node.type === 'StringLiteral') {
      const inTranslator = isTranslatorCall(parent) && parent.arguments[0] === node;
      if (inTranslator) keys.push({ line: node.loc.start.line, text: node.value });
      // Import paths and object key names are not UI text
      else if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') {
        /* path */
      } else if ((parent?.type === 'ObjectProperty' || parent?.type === 'TSPropertySignature') && key === 'key') {
        /* key */
      } else if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) {
        /* Comparison value — matched against text from the server. Translating it would break the match only in English */
      } else report(node, node.value, parent?.type === 'JSXAttribute' ? 'attr' : 'string');
    } else if (node.type === 'TemplateLiteral') {
      const inTranslator = isTranslatorCall(parent) && parent.arguments[0] === node;
      const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('{…}');
      if (inTranslator) {
        if (node.expressions.length === 0) keys.push({ line: node.loc.start.line, text: node.quasis[0].value.cooked });
      } else if (HANGUL.test(text)) {
        report(node, text, 'template');
      }
    }

    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'loc' || childKey === 'leadingComments' || childKey === 'trailingComments' || childKey === 'innerComments') continue;
      if (Array.isArray(value)) for (const item of value) walk(item, node, childKey);
      else if (value && typeof value === 'object') walk(value, node, childKey);
    }
  };
  walk(ast.program, undefined, undefined);
  return { untranslated, keys, code };
}

/** English dictionary — key -> translation. Extracted by parsing the files, not executing them (EN in i18n.ts, EN_MORE in en.ts) */
export function dictionary() {
  const found = new Map();
  for (const [name, variable] of [['i18n.ts', 'EN'], ['en.ts', 'EN_MORE']]) {
    let code;
    try {
      code = readFileSync(join(ROOT, name), 'utf8');
    } catch {
      continue;
    }
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'VariableDeclarator' && node.id.name === variable && node.init) {
        const object = ['TSAsExpression', 'TSSatisfiesExpression'].includes(node.init.type) ? node.init.expression : node.init;
        for (const property of object.properties ?? []) {
          if (property.type !== 'ObjectProperty') continue;
          const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
          const value = property.value.type === 'StringLiteral' ? property.value.value
            : property.value.type === 'TemplateLiteral' ? property.value.quasis.map((q) => q.value.cooked).join('') : undefined;
          found.set(key, value);
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
  return found;
}

/** Marks inside a key — placeholders ({0}) and tags (<b>). The translation must contain **exactly the same** ones */
export function marks(text) {
  return [...text.matchAll(/\{\w+\}|<\/?[a-z]+>|<br\s*\/>/g)].map((m) => m[0].replace(/\s/g, '')).sort().join(' ');
}

// ── Command line ────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('i18n-scan.mjs')) {
  const list = process.argv.includes('--list');
  const showKeys = process.argv.includes('--keys');
  const check = process.argv.includes('--check');
  const dump = process.argv.indexOf('--dump');
  const dict = dictionary();

  let total = 0;
  const missing = new Map();
  const used = new Set();
  const rows = [];
  for (const file of sourceFiles()) {
    const name = relative(ROOT, file).split('\\').join('/');
    if (EXEMPT_FILES.has(name)) continue;
    const { untranslated, keys } = scanFile(file);
    total += untranslated.length;
    for (const key of keys) {
      used.add(key.text);
      if (HANGUL.test(key.text) && !dict.has(key.text)) missing.set(key.text, `${name}:${key.line}`);
    }
    if (untranslated.length > 0) rows.push({ name, untranslated });
  }

  // Important: did the translation drop a placeholder or bold mark? If so, that value **silently disappears** from the screen
  const broken = [];
  for (const [key, value] of dict) {
    if (value !== undefined && marks(key) !== marks(value)) broken.push({ key, value });
  }

  // Important: CSS `content` text cannot go through the translator and stays as-is on the English screen. Pass it via attr(data-…)
  for (const file of readdirSync(join(ROOT, 'styles')).filter((name) => name.endsWith('.css'))) {
    const lines = readFileSync(join(ROOT, 'styles', file), 'utf8').split('\n');
    const untranslated = [];
    lines.forEach((line, index) => {
      if (/\bcontent\s*:/.test(line) && HANGUL.test(line.replace(/\/\*.*?\*\//g, ''))) {
        untranslated.push({ line: index + 1, kind: 'css', text: line.trim() });
      }
    });
    total += untranslated.length;
    if (untranslated.length > 0) rows.push({ name: `styles/${file}`, untranslated });
  }

  rows.sort((a, b) => b.untranslated.length - a.untranslated.length);
  for (const row of rows) {
    console.log(`${String(row.untranslated.length).padStart(5)}  ${row.name}`);
    if (list) for (const item of row.untranslated) console.log(`         ${item.line}  [${item.kind}] ${item.text.slice(0, 110)}`);
  }
  console.log(`
Korean text bypassing the translator: ${total}`);
  console.log(`Routed through the translator but missing from the English dictionary: ${missing.size} (dictionary has ${dict.size} entries)`);
  console.log(`Translations whose markers ({0} · <b>) differ from the source: ${broken.length}`);
  if (showKeys) for (const [text, where] of missing) console.log(`   ${where}  ${text.slice(0, 120)}`);
  for (const item of broken.slice(0, 20)) console.log(`   [FAIL] ${item.key.slice(0, 70)}
      → ${String(item.value).slice(0, 70)}`);

  // List handed to translators — records which screen each text belongs to
  if (dump > 0) {
    const grouped = {};
    for (const [text, where] of missing) (grouped[where.split(':')[0]] ??= []).push(text);
    writeFileSync(process.argv[dump + 1], JSON.stringify(grouped, null, 1));
    console.log(`
Wrote ${missing.size} entries to ${process.argv[dump + 1]}.`);
  }

  if (check && (total > 0 || missing.size > 0 || broken.length > 0)) process.exit(1);
}
