/**
 * Comment-only change guard.
 *
 * Proves that a change touched comments (and test titles) only: for every changed source file it compares the
 * token stream of the base version with the working tree, with comments removed. Any difference in code — an
 * identifier, an operator, a string the program uses — fails the check.
 *
 *     node scripts/comment-guard.mjs [base-ref] [--only <path-prefix>]   # default base: origin/main
 *
 * Allowed besides comments:
 *   - the title string of describe / it / test (and .skip / .only / .each variants) in test files
 * Covered file types: .ts .tsx .mts .js .mjs (token compare), .css (compare with comments stripped),
 * .sh .py Dockerfile .yml .yaml (compare with full-line # comments stripped; shebang kept).
 *
 * Why: translating thousands of comment lines by hand or by agents must not change behaviour. A guard that only
 * says "tests pass" can miss a changed string that no test reads (a translation key, a log line).
 */
import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;
const base = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? 'origin/main';

const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

const TEST_FN = new Set(['describe', 'it', 'test', 'suite']);

function testTitleRanges(ast) {
  const ranges = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression') {
      let callee = node.callee;
      // describe.skip(...) · it.each([...])(title, ...) · test.only(...)
      if (callee.type === 'CallExpression') callee = callee.callee;
      if (callee.type === 'MemberExpression') callee = callee.object;
      if (callee.type === 'Identifier' && TEST_FN.has(callee.name)) {
        const first = node.arguments[0];
        if (first && (first.type === 'StringLiteral' || first.type === 'TemplateLiteral')) ranges.push([first.start, first.end]);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program);
  return ranges;
}

function tokenStream(code, file) {
  const plugins = ['typescript', 'decorators-legacy'];
  if (/\.(tsx|jsx|js|mjs)$/.test(file)) plugins.push('jsx');
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins, tokens: true, errorRecovery: false });
  } catch {
    // .ts files that are not JSX can fail with the jsx plugin and vice versa — retry without it
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], tokens: true });
  }
  const isTest = /(^|\/)test\/|\.test\.(ts|tsx|mjs|js)$/.test(file);
  const titles = isTest ? testTitleRanges(ast) : [];
  const inTitle = (t) => titles.some(([s, e]) => t.start >= s && t.end <= e);
  return ast.tokens
    .filter((t) => t.type !== 'CommentLine' && t.type !== 'CommentBlock')
    .map((t) => (inTitle(t) ? '«test-title»' : `${t.type.label ?? t.type}:${code.slice(t.start, t.end)}`))
    .filter((t, i, list) => !(t === '«test-title»' && list[i - 1] === '«test-title»'));
}

const stripCss = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
const stripHash = (code) =>
  code
    .split('\n')
    .filter((line, i) => !(/^\s*#/.test(line) && !(i === 0 && line.startsWith('#!'))))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');

function compare(file, before, after) {
  if (/\.(ts|tsx|mts|js|mjs)$/.test(file)) {
    const a = tokenStream(before, file);
    const b = tokenStream(after, file);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `token ${i}: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`;
    return undefined;
  }
  if (/\.css$/.test(file)) return stripCss(before) === stripCss(after) ? undefined : 'CSS outside comments changed';
  if (/\.(sh|py|ya?ml)$|(^|\/)Dockerfile$/.test(file)) return stripHash(before) === stripHash(after) ? undefined : 'lines outside # comments changed';
  return 'not a covered file type — review by hand';
}

const changed = git('diff', '--name-only', '--diff-filter=M', base, '--')
  .split('\n')
  .filter(Boolean)
  .filter((f) => !only || f.startsWith(only));
let failures = 0;
for (const file of changed) {
  if (!existsSync(file)) continue;
  const before = git('show', `${base}:${file}`);
  const after = readFileSync(file, 'utf8');
  const problem = compare(file, before, after);
  if (problem) {
    failures++;
    console.log(`[FAIL] ${file} — ${problem}`);
  }
}
console.log(`comment-guard: ${changed.length} changed file(s) checked against ${base}, ${failures} with code changes`);
if (failures > 0) process.exit(1);
