/**
 * 화면 간격 검사 — 간격에 숫자를 직접 적은 곳과, 간격 단계 밖의 배수를 찾는다.
 *
 *     node scripts/spacing-scan.mjs            # 목록
 *     node scripts/spacing-scan.mjs --check    # 하나라도 있으면 종료코드 1 (CI용)
 *
 * 약속(apps/web/src/styles/aas.css 머리말과 같다):
 *   - 간격(margin · padding · gap · inset · top/right/bottom/left)은 --spacing(4px)의 배수로만 쓴다
 *   - 배수는 표준 단계 0.5 · 1 · 1.5 · 2 · 2.5 · 3 · 4 · 5 · 6 · 8 · 10 · 12 · 16 만
 *   - 자리마다 같아야 하는 간격은 이름 붙은 토큰(--space-pane · --space-dialog · …)으로
 *   - 화면 코드(.tsx)의 style 에 여백 숫자를 적지 않는다 — 클래스와 토큰으로
 *   - 세로 여백 · 사이 간격(margin · gap)은 4 · 8 · 12 · 16 · 24 · 32px 리듬 — 1.5 · 2.5 · 5배를 쓰지 않는다
 *   - 줄 간격은 --leading-tight · normal · relaxed 세 가지(또는 1)
 * 왜 도구인가: 2026-10-14 실측에서 칸마다 여백이 6 · 13 · 14px 로 갈렸고, 설정 창은 1px 였다. 눈으로는 고친 만큼만 고쳐진다.
 *
 * 예외는 그 줄에 `spacing-ignore — 까닭`을 적는다(CSS 는 주석, TSX 는 // 주석).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = 'apps/web/src/styles';
const SRC = 'apps/web/src';
/** shadcn 이 만든 부품(Tailwind 클래스)과 글꼴 정의는 대상이 아니다 */
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
      // 세로 여백 · 사이 간격은 더 좁은 단계 — 4 · 8 · 12 · 16 · 24 · 32px 리듬(1.5 · 2.5 · 5배는 쓰지 않는다)
      if (/^(margin|gap|row-gap|column-gap)/.test(prop) && /var\(--spacing\)\s*\*\s*-?(1\.5|2\.5|5)\b/.test(value)) {
        problems.push({ line: index + 1, kind: '세로 리듬 밖', text: `${prop}: ${value.trim()}` });
      }
      // calc(var(--spacing) …) · var(--…) 를 뺀 나머지에 0 이 아닌 길이가 있으면 숫자를 직접 적은 것이다
      const rest = value.replace(/var\([^)]*\)/g, '').replace(/\*\s*-?[\d.]+/g, '');
      if (/(?<![\w.#-])-?(?:\d*\.)?\d+(px|rem|em)\b/.test(rest) && !/(?<![\w.#-])-?0(px|rem|em)?\b/.test(rest.trim())) {
        problems.push({ line: index + 1, kind: '숫자 간격', text: `${prop}: ${value.trim()}` });
      }
    }
  });
  // 줄 간격 — 토큰(--leading-tight · normal · relaxed) 또는 1(아이콘 한 줄)만
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
    // style={{ paddingLeft: 8 … }} · margin: '12px' — 여백을 화면 코드에 숫자로
    for (const match of line.matchAll(/\b(padding|margin|gap|rowGap|columnGap)[A-Za-z]*\s*:\s*([^,}]+)/g)) {
      if (/(^|[^\w.])\d/.test(match[2]) && !/var\(/.test(match[2])) problems.push({ line: index + 1, kind: '코드 여백', text: match[0].trim() });
    }
    // Tailwind 임의값 간격 p-[13px] · gap-[6px]
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
