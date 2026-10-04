/**
 * IDTA Part 2 규격 대조.
 *
 * 우리 라우트 표(@aas/api)를 저장소에 넣어 둔 규격 원문(docs/spec/part2/)과 맞대어 본다.
 * 세 가지를 본다.
 *   ① 규격에 있는데 우리가 없는 것        (미구현)
 *   ② 있는데 성공 상태코드가 다른 것       (규격 위반 — 조용히 클라이언트를 깨뜨린다)
 *   ③ 규격에 없는 경로를 우리가 연 것       (확장인지 사고인지 구분해야 한다)
 *
 * 사용: node scripts/part2-coverage.mjs [--all]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoutes, AASX_FILE_SERVER_PROFILES, PART2_PROFILES } from '@aas/api';
import { InMemoryStore } from '@aas/store';

const SPEC_DIR = 'docs/spec/part2';
/** Part 2 저장소 계열 경로를 우리가 어디에 걸어 뒀는지 */
const PART2_PREFIX = '/packages/:packageId/api/v3.0';
/** 레지스트리·디스커버리는 서버 단위라 파일 경로 아래에 두지 않는다 */
const REGISTRY_PREFIX = '/api/v3.0';
/** 규격 밖이라고 우리가 의도한 경로 */
const EXTENSIONS = [
  '/health',
  `${'/packages/:packageId'}/metadata`,
  '/packages/:packageId/lint',
  '/packages/:packageId/fix',
  '/packages/:packageId/fix-preview',
  '/packages/:packageId/relocations',
  '/packages/:packageId/relocations/revert',
  '/packages/:packageId/policy',
  '/packages/:packageId/import-submodel',
  '/packages/:packageId/report',
  '/packages/:packageId/revisions',
  '/packages/:packageId/interfaces',
  '/packages/:packageId/values',
  '/packages/:packageId/collect',
  '/packages/:packageId/aid',
  // 저작 도구 자체 기능 — 규격에는 "새로 만들기"가 없다(AasxFileServer는 업로드만 다룬다)
  '/packages/:packageId/diagram.svg',
  '/packages/:packageId/table',
  '/packages/:packageId/doc-plan',
  '/packages/:packageId/live',
  '/registry-conflicts',
  '/collect-status',
  '/packages/new',
  '/policy',
  '/rules',
  // 2026-09-03 추가 — 아래 7경로가 빠져 있어 이 스크립트가 한동안 종료코드 1이었다.
  // 문지기가 울리는데 아무도 못 봤다. 새 경로를 만들면 여기에도 적는다
  '/packages/:packageId/clone',
  '/packages/:packageId/history/:submodelId',
  '/packages/:packageId/history/:submodelId/restore',
  '/packages/:packageId/hierarchy',
  '/packages/:packageId/hierarchy/nodes',
  '/packages/:packageId/hierarchy/nodes/:name',
  '/opcua/browse',
  // 2026-09-30 — 레퍼런스 번들(공정 파일 → 제출 꾸러미 한 벌, 다시 열기)
  '/packages/:packageId/bundle',
  '/packages/:packageId/bundle/linkage',
  '/bundles',
  '/packages/:packageId/bundle/files',
  // 2026-09-30 — 내장 가상 PLC로 연결(평가자 재현)
  '/packages/:packageId/simulate',
  // 2026-10-02 — 사람 로그인. 규격(Part 2)은 기계 간 인터페이스만 정하고 사람 인증은 다루지
  //   않는다. 토큰(API 키)은 그대로 두고 사람만 세션으로 옮긴 것이라 규격 적합성과 무관하다
  '/auth/me',
  '/auth/login',
  '/auth/logout',
  '/auth/setup',
  '/auth/signup',
  '/auth/users',
  '/auth/users/:userId',
  '/auth/password',
  // 2026-09-04 — 되돌리기·다시 하기(패키지 단위 스냅샷)
  '/packages/:packageId/undo',
  '/packages/:packageId/redo',
  // 2026-09-04 — 요소 순서 바꾸기·복제(규격에 없는 저작 연산). 두 prefix에 다 걸린다
  '/packages/:packageId/api/v3.0/submodels/:identifier/submodel-elements/:path/move',
  '/packages/:packageId/api/v3.0/submodels/:identifier/submodel-elements/:path/duplicate',
  '/packages/:packageId/api/v3.0/shells/:identifier/submodels/:submodelIdentifier/submodel-elements/:path/move',
  '/packages/:packageId/api/v3.0/shells/:identifier/submodels/:submodelIdentifier/submodel-elements/:path/duplicate',
];

/** OpenAPI YAML에서 (메서드, 경로, 성공코드)만 훑어 낸다 — 의존성 없이 들여쓰기로 읽는다 */
function readSpec(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  let inPaths = false;
  let path = null;
  let method = null;
  let inResponses = false;

  for (const raw of lines) {
    if (/^paths:/.test(raw)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[a-zA-Z]/.test(raw)) break;

    const pathLine = /^ {2}(\/\S*):\s*$/.exec(raw);
    if (pathLine) {
      path = pathLine[1];
      method = null;
      continue;
    }
    const methodLine = /^ {4}(get|put|post|patch|delete):\s*$/.exec(raw);
    if (methodLine) {
      method = methodLine[1].toUpperCase();
      inResponses = false;
      continue;
    }
    if (/^ {6}responses:/.test(raw)) {
      inResponses = true;
      continue;
    }
    if (inResponses && method) {
      const code = /^ {8}'?(\d{3})'?:/.exec(raw);
      if (code) {
        if (code[1].startsWith('2')) out.push({ method, path, code: code[1] });
      } else if (/^ {6}\S/.test(raw)) {
        inResponses = false;
      }
    }
  }
  return out;
}

/** 파라미터 이름 차이를 지운다: `/submodels/{submodelIdentifier}` == `/submodels/:identifier` */
function normalize(path) {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') || /^\{.*\}$/.test(segment) ? '{}' : segment))
    .join('/');
}

const specFiles = readdirSync(SPEC_DIR).filter((n) => n.endsWith('.yaml'));
const spec = new Map();
for (const file of specFiles) {
  for (const entry of readSpec(join(SPEC_DIR, file))) {
    const key = `${entry.method} ${normalize(entry.path)}`;
    if (!spec.has(key)) spec.set(key, { ...entry, file, key });
  }
}

const ours = new Map();
for (const route of buildRoutes(new InMemoryStore())) {
  const pattern = route.pattern;
  const specPath = pattern.startsWith(PART2_PREFIX)
    ? pattern.slice(PART2_PREFIX.length) || '/'
    : pattern.startsWith(REGISTRY_PREFIX)
      ? pattern.slice(REGISTRY_PREFIX.length) || '/'
      : pattern;
  ours.set(`${route.method} ${normalize(specPath)}`, { pattern, method: route.method });
}

const implemented = [];
const missing = [];
const wrongCode = [];
for (const [key, entry] of spec) {
  const mine = ours.get(key);
  if (!mine) {
    missing.push({ key, entry });
    continue;
  }
  implemented.push({ key, entry });
  // 성공 상태코드가 규격과 다르면 클라이언트가 조용히 깨진다
  if (mine.success && !mine.success.includes(Number(entry.code))) {
    wrongCode.push({ key, expected: entry.code, actual: mine.success.join(',') });
  }
}

/**
 * /description이 광고하는 프로필을 정말 다 구현했는지 확인한다.
 * 프로필 문자열만 적어 두고 연산을 빼먹으면 클라이언트가 있는 줄 알고 부르다 깨진다.
 */
const profileFiles = {
  'AasxFileServerServiceSpecification/SSP-001': 'AasxFileServer_V3.0_SSP-001.yaml',
  'ConceptDescriptionServiceSpecification/SSP-001':
    'ConceptDescriptionServiceSpecification_V3.0_SSP-001.yaml',
};
const claimed = [...AASX_FILE_SERVER_PROFILES, ...PART2_PROFILES];
const brokenProfiles = [];
for (const profile of claimed) {
  const suffix = Object.keys(profileFiles).find((k) => profile.endsWith(k));
  if (!suffix) {
    brokenProfiles.push({ profile, missing: ['규격 원문이 저장소에 없다'] });
    continue;
  }
  const ops = readSpec(join(SPEC_DIR, profileFiles[suffix]));
  const notImplemented = [];
  for (const op of ops) {
    const key = `${op.method} ${normalize(op.path)}`;
    if (!ours.has(key)) notImplemented.push(key);
  }
  if (notImplemented.length > 0) brokenProfiles.push({ profile, missing: notImplemented });
}
const extras = [...ours.entries()].filter(([key, value]) => {
  if (spec.has(key)) return false;
  return !EXTENSIONS.some((e) => value.pattern === e);
});

const showAll = process.argv.includes('--all');
const pct = ((implemented.length / spec.size) * 100).toFixed(0);

console.log(`IDTA Part 2 (v3.0.4) 대조 — 규격 연산 ${spec.size}종 중 ${implemented.length}종 구현 (${pct}%)\n`);

console.log(`■ 구현함 (${implemented.length})`);
for (const { key } of implemented) console.log(`   ✅ ${key}`);

console.log(`\n■ 미구현 (${missing.length})`);
const byFile = new Map();
for (const { key, entry } of missing) {
  const group = entry.file.replace(/ServiceSpecification.*|_V3.*/g, '');
  byFile.set(group, [...(byFile.get(group) ?? []), key]);
}
for (const [group, keys] of byFile) {
  console.log(`   ${group}: ${keys.length}종`);
  if (showAll) for (const key of keys) console.log(`      ⬜ ${key}`);
}
if (!showAll) console.log('   (--all로 전체 목록)');

console.log(`\n■ 성공 상태코드 불일치 (${wrongCode.length})`);
for (const w of wrongCode) console.log(`   ❌ ${w.key} — 규격 ${w.expected}, 우리 ${w.actual}`);
if (wrongCode.length === 0) console.log('   없음');

console.log(`\n■ 규격에 없는 경로 (${extras.length})`);
for (const [key, value] of extras) console.log(`   ⚠️  ${key}  ← ${value.pattern}`);
if (extras.length === 0) console.log('   없음 — 표준 경로를 우리 뜻대로 바꿔 쓴 곳이 없다');

// 프로필별 충족도 — 무엇을 더 채우면 한 프로필이 완성되는지 보여 준다
console.log('\n■ 프로필별 충족도');
for (const file of specFiles) {
  const ops = readSpec(join(SPEC_DIR, file));
  if (ops.length === 0) continue;
  const done = ops.filter((op) => ours.has(`${op.method} ${normalize(op.path)}`));
  const name = file.replace(/ServiceSpecification|_V3.*|\.yaml/g, '');
  const missingHere = ops.length - done.length;
  const mark = missingHere === 0 ? '✅' : '  ';
  console.log(
    `   ${mark} ${name.padEnd(42)} ${String(done.length).padStart(3)}/${String(ops.length).padEnd(3)}` +
      (missingHere > 0 ? `  (남은 ${missingHere}종)` : ''),
  );
}

console.log(`\n■ /description이 광고하는 프로필 (${claimed.length})`);
for (const profile of claimed) {
  const broken = brokenProfiles.find((b) => b.profile === profile);
  const name = profile.replace('https://admin-shell.io/aas/API/3/0/', '');
  if (!broken) console.log(`   ✅ ${name} — 연산 전부 구현`);
  else console.log(`   ❌ ${name} — 미구현 ${broken.missing.length}종: ${broken.missing.join(', ')}`);
}

const failed = extras.length + wrongCode.length + brokenProfiles.length;
process.exit(failed > 0 ? 1 : 0);
