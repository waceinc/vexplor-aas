/**
 * 공개할 폴더에 **나가면 안 되는 것**이 섞였는지 본다.
 *
 *     node scripts/check-public-tree.mjs out/public
 *
 * 하나라도 걸리면 종료코드 1. scripts/make-public.sh가 뽑은 뒤에 부른다.
 *
 * 🔴 **허용 목록으로 뽑았으니 괜찮다**고 믿지 않는다. 허용한 폴더 안의 파일에 사내 주소나
 *    실제 회사 이름이 한 줄 섞여 있을 수 있다. 그래서 뽑은 **결과물**을 다시 훑는다.
 *    공개는 되돌릴 수 없다 — 한 번 나간 것은 지워도 누군가의 사본에 남는다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'out/public');
if (!existsSync(root)) {
  console.error(`🔴 폴더가 없습니다: ${root}`);
  process.exit(1);
}

/** 있으면 안 되는 길 — 사업 자료·내부 기록·남의 저작물 */
const FORBIDDEN_PATHS = [
  'CLAUDE.md',
  '.mcp.json',
  '.gitea',
  'docs/rules',
  'docs/PROGRESS.md',
  'docs/mcp.md',
  'docs/오픈소스_공개_점검.md',
  'docs/웹로그인_오픈소스공개_계획.md',
  // 실제 이름 → 꾸민 이름의 대응표가 들어 있다. 나가면 익명화한 뜻이 없다
  'scripts/anonymize-fixtures.py',
  'out',
  'node_modules',
  '.env',
];

/** 있으면 안 되는 종류 — 문서 원본·디자인 원본은 대개 남의 것이거나 사업 자료다 */
const FORBIDDEN_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.hwp', '.hwpx', '.ai', '.psd']);

/** 글자 검사 — [무엇인지, 정규식] */
const FORBIDDEN_TEXT = [
  ['사내 저장소 주소', /g\.wace\.me|[a-z0-9.-]*wace\.me/i],
  ['사내 서버·PC 주소', /192\.168\.0\.(236|119)\b/],
  ['사내 경로', /AAS 백업|basyx-setup|aas_research|C:\\ORCA|C:\\Users\\|\/c\/Users\//],
  ['개인 계정', /myyh\d*|lyh100\d*/i],
  ['사업 맥락', /중기부|70종|데이터표준화 사업|사업계획서/],
  ['실제 회사·제품', /SIMPAC|Samick|두산로보틱스|Doosan Robotics|Atlas ?Copco|Henrob|A0509s/],
  ['비밀값', /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bp]-[A-Za-z0-9-]{10,}/],
];

/**
 * 글자 검사에서 빼는 파일.
 *  - scan-fixture-names.py: 찾으려는 상표 **목록**이 들어 있다(널리 알려진 이름의 나열이지 유출이 아니다)
 *  - check-public-tree.mjs: 이 파일 — 위의 정규식이 스스로에게 걸린다
 *  - package-lock.json: 꾸러미 이름·해시뿐이고, 크다
 */
const TEXT_EXEMPT = new Set(['scripts/scan-fixture-names.py', 'scripts/check-public-tree.mjs', 'package-lock.json']);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.css', '.html', '.py', '.sh',
  '.bat', '.command', '.example', '.sql', '.svg', '',
]);

const problems = [];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);

const rel = (full) => relative(root, full).split('\\').join('/');

// ① 있으면 안 되는 길
for (const path of FORBIDDEN_PATHS) {
  if (existsSync(join(root, path))) problems.push(`있으면 안 되는 길: ${path}`);
}

for (const full of files) {
  const path = rel(full);
  const extension = extname(full).toLowerCase();

  // ② 있으면 안 되는 종류
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    problems.push(`있으면 안 되는 종류(${extension}): ${path}`);
    continue;
  }

  // ③ 글자 검사
  if (!TEXT_EXTENSIONS.has(extension) && !path.startsWith('.')) continue;
  if (TEXT_EXEMPT.has(path)) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (const [what, pattern] of FORBIDDEN_TEXT) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) problems.push(`${what}: ${path}:${index + 1}  ${line.trim().slice(0, 100)}`);
    });
  }

  // ④ 문서 안의 죽은 링크 — 공개하지 않은 문서를 가리키면 독자가 막다른 길에 선다
  if (extension === '.md') {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue; // 같은 문서 안의 닻(#…)
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http: · mailto: 같은 바깥 주소
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        /* 그대로 본다 */
      }
      const resolved = resolve(dirname(full), decoded);
      if (!resolved.startsWith(root)) continue; // 저장소 밖을 가리키는 GitHub 경로
      if (!existsSync(resolved)) problems.push(`죽은 링크: ${path} → ${target}`);
    }
  }
}

// ⑤ 있어야 하는 것 — 빠지면 공개 저장소가 성립하지 않는다
for (const path of ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD-PARTY-NOTICES.md', 'package.json']) {
  if (!existsSync(join(root, path))) problems.push(`있어야 하는데 없다: ${path}`);
}

console.log(`검사한 파일 ${files.length}개 — ${root}`);
if (problems.length > 0) {
  console.error(`\n🔴 ${problems.length}건이 걸렸습니다 — 이대로 공개하면 안 됩니다:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('✅ 나가면 안 되는 것이 없습니다.');
