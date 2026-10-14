/**
 * Checks whether anything that **must not go out** has slipped into the folder to be published.
 *
 *     node scripts/check-public-tree.mjs out/public
 *
 * Exits with code 1 if anything is caught. Run after scripts/make-public.sh has extracted the tree.
 *
 * Important: do not assume **"it was extracted from an allow-list, so it is fine"**. A file inside an allowed
 *    folder can still carry a line with an internal address or a real company name. So the extracted **output**
 *    is scanned again. Publishing cannot be undone — once out, deleting it still leaves it in someone's copy.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'out/public');
if (!existsSync(root)) {
  console.error(`🔴 폴더가 없습니다: ${root}`);
  process.exit(1);
}

/** Paths that must not exist — business material, internal records, third-party works */
const FORBIDDEN_PATHS = [
  'CLAUDE.md',
  '.mcp.json',
  '.gitea',
  'docs/rules',
  'docs/PROGRESS.md',
  'docs/mcp.md',
  'docs/오픈소스_공개_점검.md',
  'docs/웹로그인_오픈소스공개_계획.md',
  // Contains the real-name -> fictional-name mapping table. If it leaks, the anonymization is pointless
  'scripts/anonymize-fixtures.py',
  'out',
  'node_modules',
  '.env',
];

/** File types that must not exist — source documents and design files are usually third-party or business material */
const FORBIDDEN_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.hwp', '.hwpx', '.ai', '.psd']);

/** Text checks — [what it is, regex] */
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
 * Files excluded from the text check.
 *  - scan-fixture-names.py: contains the **list** of trademarks to look for (a list of well-known names, not a leak)
 *  - check-public-tree.mjs: this file — the regexes above would match themselves
 *  - package-lock.json: only package names and hashes, and it is large
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

// (1) Paths that must not exist
for (const path of FORBIDDEN_PATHS) {
  if (existsSync(join(root, path))) problems.push(`있으면 안 되는 길: ${path}`);
}

for (const full of files) {
  const path = rel(full);
  const extension = extname(full).toLowerCase();

  // (2) File types that must not exist
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    problems.push(`있으면 안 되는 종류(${extension}): ${path}`);
    continue;
  }

  // (3) Text check
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

  // (4) Dead links inside documents — a link to an unpublished document leads the reader to a dead end
  if (extension === '.md') {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue; // anchor within the same document (#...)
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URL such as http: or mailto:
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        /* use as-is */
      }
      const resolved = resolve(dirname(full), decoded);
      if (!resolved.startsWith(root)) continue; // GitHub path pointing outside the repository
      if (!existsSync(resolved)) problems.push(`죽은 링크: ${path} → ${target}`);
    }
  }
}

// (5) Required files — without them the public repository is not valid
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
