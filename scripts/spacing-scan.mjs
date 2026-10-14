/**
 * UI spacing check — finds spacing written as raw numbers and multiples outside the spacing scale.
 *
 *     node scripts/spacing-scan.mjs            # list
 *     node scripts/spacing-scan.mjs --check    # exit code 1 if anything is found (for CI)
 *
 * Conventions (same as the header of apps/web/src/styles/aas.css):
 *   - Spacing (margin, padding, gap, inset, top/right/bottom/left) uses only multiples of --spacing (4px)
 *   - Multiples only from the standard scale 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16
 *   - Spacing that must match across places uses named tokens (--space-pane, --space-dialog, ...)
 *   - No spacing numbers in `style` in UI code (.tsx) — use classes and tokens
 *   - Vertical margins and gaps (margin, gap) follow a 4/8/12/16/24/32px rhythm — no 1.5x, 2.5x or 5x
 *   - Line height is one of --leading-tight / normal / relaxed (or 1)
 * Why a tool: a 2026-10-14 measurement found padding varying between 6, 13 and 14px across panels, and 1px in the settings dialog. Fixing by eye only fixes what you happen to see.
 *
 * Exceptions carry `spacing-ignore — reason` on that line (a comment in CSS, a // comment in TSX).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = 'apps/web/src/styles';
const SRC = 'apps/web/src';
/** shadcn-generated components (Tailwind classes) and font definitions are out of scope */
const SKIP = [/apps\/web\/src\/drive\/ui\/kit\//, /pretendard-alias\.css$/];
const SCALE = new Set(['0', '0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '8', '10', '12', '16', '24']);
const SPACING_PROP = /(?<![\w-])(margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|gap|row-gap|column-gap|inset(?:-[a-z]+)?|top|right|bottom|left)\s*:\s*([^;{}]+)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full.split('\\').join('/'));
  }
  return out;
}

export function scanCss(file) {
  const problems = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (line.includes('spacing-ignore')) return;
    const code = line.replace(/\/\*.*?\*\//g, '');
    for (const match of code.matchAll(SPACING_PROP)) {
      const [, prop, value] = match;
      for (const factor of value.matchAll(/var\(--spacing\)\s*\*\s*(-?[\d.]+)/g)) {
        const n = String(Math.abs(Number(factor[1])));
        if (!SCALE.has(n)) problems.push({ line: index + 1, kind: '단계 밖', text: `${prop}: ${value.trim()}` });
      }
      // Vertical margins and gaps use a narrower scale — 4/8/12/16/24/32px rhythm (no 1.5x, 2.5x or 5x)
      if (/^(margin|gap|row-gap|column-gap)/.test(prop) && /var\(--spacing\)\s*\*\s*-?(1\.5|2\.5|5)\b/.test(value)) {
        problems.push({ line: index + 1, kind: '세로 리듬 밖', text: `${prop}: ${value.trim()}` });
      }
      // A non-zero length left after removing calc(var(--spacing) …) and var(--…) means a raw number was written
      const rest = value.replace(/var\([^)]*\)/g, '').replace(/\*\s*-?[\d.]+/g, '');
      if (/(?<![\w.#-])-?(?:\d*\.)?\d+(px|rem|em)\b/.test(rest) && !/(?<![\w.#-])-?0(px|rem|em)?\b/.test(rest.trim())) {
        problems.push({ line: index + 1, kind: '숫자 간격', text: `${prop}: ${value.trim()}` });
      }
    }
  });
  // Line height — only tokens (--leading-tight / normal / relaxed) or 1 (single icon line)
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (line.includes('spacing-ignore')) return;
    for (const match of line.replace(/\/\*.*?\*\//g, '').matchAll(/line-height\s*:\s*([^;{}]+)/g)) {
      const value = match[1].trim();
      if (!/^var\(--leading-[a-z]+\)$/.test(value) && value !== '1' && value !== 'inherit' && value !== 'normal') {
        problems.push({ line: index + 1, kind: '줄 간격 숫자', text: `line-height: ${value}` });
      }
    }
  });
  return problems;
}

export function scanTsx(file) {
  const problems = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (line.includes('spacing-ignore')) return;
    // style={{ paddingLeft: 8 … }} · margin: '12px' — spacing as raw numbers in UI code
    for (const match of line.matchAll(/\b(padding|margin|gap|rowGap|columnGap)[A-Za-z]*\s*:\s*([^,}]+)/g)) {
      if (/(^|[^\w.])\d/.test(match[2]) && !/var\(/.test(match[2])) problems.push({ line: index + 1, kind: '코드 여백', text: match[0].trim() });
    }
    // Tailwind arbitrary-value spacing p-[13px] · gap-[6px]
    for (const match of line.matchAll(/\b-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|top|left|right|bottom|inset)-\[[^\]]+\]/g)) {
      problems.push({ line: index + 1, kind: '임의값 클래스', text: match[0] });
    }
  });
  return problems;
}

if (process.argv[1]?.endsWith('spacing-scan.mjs')) {
  const rows = [];
  for (const file of walk(STYLES).filter((f) => f.endsWith('.css') && !SKIP.some((re) => re.test(f)))) {
    for (const p of scanCss(file)) rows.push({ file, ...p });
  }
  for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f) && !SKIP.some((re) => re.test(f)))) {
    for (const p of scanTsx(file)) rows.push({ file, ...p });
  }
  for (const row of rows) console.log(`   [FAIL] ${row.file}:${row.line} [${row.kind}] ${row.text.slice(0, 110)}`);
  console.log(`간격 검사: 숫자 · 단계 밖 간격 ${rows.length}곳`);
  if (process.argv.includes('--check') && rows.length > 0) process.exit(1);
}
