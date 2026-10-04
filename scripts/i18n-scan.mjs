/**
 * 화면 코드에서 **번역기를 거치지 않는 한국어**를 찾는다.
 *
 *     node scripts/i18n-scan.mjs              # 파일별 개수
 *     node scripts/i18n-scan.mjs --list       # 하나씩 전부
 *     node scripts/i18n-scan.mjs --keys       # 번역기를 거치는 글자 중 영어 사전에 없는 것
 *     node scripts/i18n-scan.mjs --check      # 둘 중 하나라도 남았으면 종료코드 1 (CI용)
 *
 * 왜 도구인가: 영문은 「뼈대만」에서 오래 멈춰 있었다. 눈으로 찾아 고치면 고친 만큼만 되고,
 * 새 화면을 만들 때마다 다시 샌다. **세는 도구**가 있어야 끝이 있고, 끝난 뒤에도 지켜진다.
 *
 * 무엇을 세나 (주석은 세지 않는다 — 주석은 한국어가 맞다)
 *   - JSX 글자                 <p>저장했습니다</p>
 *   - 글자 속성                title="…" placeholder="…" aria-label="…"
 *   - 식 안의 문자열·템플릿    setError('…') · `위반 ${n}건`
 * 번역기 호출의 인자는 센 것으로 치지 않는다:  t('…') · tr('…') · fill(tr('…'), …)
 *
 * 🔴 정규식이 아니라 **파서**로 읽는다. 시험 파일 익명화 때 정규식으로 JSON을 훑다가
 *    따옴표 짝이 뒤집혀 실제 회사 이름 하나를 놓쳤다. 찾는 도구가 조용히 놓치는 것이 가장 나쁘다.
 */
import { parse } from '@babel/parser';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'apps/web/src';
const HANGUL = /[가-힣]/;
/** 번역기 — 이 함수의 첫 인자는 사전의 열쇠다 */
const TRANSLATORS = new Set(['t', 'tr']);

/** 한국어가 맞는 자리 — 번역 대상이 아니다 */
const EXEMPT_FILES = new Set([
  'i18n.ts', // 사전 자체
  'en.ts', // 사전 자체
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

/** 한 파일을 읽어 { untranslated, keys } 를 돌려준다 */
export function scanFile(file) {
  const code = readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], ranges: false });
  const untranslated = [];
  const keys = [];
  // `// i18n-ignore` — 그 줄과 **바로 다음 줄**은 글자가 아니라 값이다(글꼴 이름 같은).
  // 까닭을 옆에 적게 한다: 표시만 있으면 왜 뺐는지 다음 사람이 모른다
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

  /** parent 사슬을 들고 내려간다 — 「번역기 인자인가」를 알려면 부모가 필요하다 */
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;

    // 타입 자리의 문자열('admin' | 'editor')은 글자가 아니다
    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSSatisfiesExpression') {
      return;
    }

    // <T k="…" /> — 통문장 번역. k가 사전의 열쇠다
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
      // import 경로 · 객체의 열쇠 이름은 글자가 아니다
      else if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') {
        /* 경로 */
      } else if ((parent?.type === 'ObjectProperty' || parent?.type === 'TSPropertySignature') && key === 'key') {
        /* 열쇠 */
      } else if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) {
        /* 견주는 값 — 서버가 준 글자와 맞춰 보는 자리다. 옮기면 영어일 때만 안 맞는다 */
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

/** 영어 사전 — 열쇠 → 번역. 실행하지 않고 파일을 읽어 꺼낸다(i18n.ts의 EN · en.ts의 EN_MORE) */
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

/** 열쇠에 든 표시 — 값 자리({0})와 태그(<b>). 번역문에도 **똑같이** 있어야 한다 */
export function marks(text) {
  return [...text.matchAll(/\{\w+\}|<\/?[a-z]+>|<br\s*\/>/g)].map((m) => m[0].replace(/\s/g, '')).sort().join(' ');
}

// ── 명령줄 ────────────────────────────────────────────────────────────────
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

  // 🔴 번역문이 값 자리나 굵은 글씨 표시를 빠뜨렸는가. 빠뜨리면 화면에서 그 값이 **조용히 사라진다**
  const broken = [];
  for (const [key, value] of dict) {
    if (value !== undefined && marks(key) !== marks(value)) broken.push({ key, value });
  }

  rows.sort((a, b) => b.untranslated.length - a.untranslated.length);
  for (const row of rows) {
    console.log(`${String(row.untranslated.length).padStart(5)}  ${row.name}`);
    if (list) for (const item of row.untranslated) console.log(`         ${item.line}  [${item.kind}] ${item.text.slice(0, 110)}`);
  }
  console.log(`
번역기를 거치지 않는 한국어: ${total}곳`);
  console.log(`번역기를 거치지만 영어 사전에 없는 것: ${missing.size}개 (사전 ${dict.size}항목)`);
  console.log(`번역문의 표시({0} · <b>)가 원문과 다른 것: ${broken.length}개`);
  if (showKeys) for (const [text, where] of missing) console.log(`   ${where}  ${text.slice(0, 120)}`);
  for (const item of broken.slice(0, 20)) console.log(`   🔴 ${item.key.slice(0, 70)}
      → ${String(item.value).slice(0, 70)}`);

  // 옮길 사람에게 넘길 목록 — 어느 화면의 글자인지 함께 적는다
  if (dump > 0) {
    const grouped = {};
    for (const [text, where] of missing) (grouped[where.split(':')[0]] ??= []).push(text);
    writeFileSync(process.argv[dump + 1], JSON.stringify(grouped, null, 1));
    console.log(`
${process.argv[dump + 1]}에 ${missing.size}개를 적었다.`);
  }

  if (check && (total > 0 || missing.size > 0 || broken.length > 0)) process.exit(1);
}
