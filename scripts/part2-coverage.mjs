/**
 * IDTA Part 2 spec comparison.
 *
 * Compares our route table (@aas/api) against the spec source checked into the repository (docs/spec/part2/).
 * Three things are checked.
 *   (1) In the spec but missing from us          (not implemented)
 *   (2) Present but with a different success code (spec violation — silently breaks clients)
 *   (3) Paths we expose that the spec does not have (must tell an intended extension from an accident)
 *
 * Usage: node scripts/part2-coverage.mjs [--all]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoutes, AASX_FILE_SERVER_PROFILES, PART2_PROFILES } from '@aas/api';
import { InMemoryStore } from '@aas/store';

const SPEC_DIR = 'docs/spec/part2';
/** Where we mount the Part 2 repository-family paths */
const PART2_PREFIX = '/packages/:packageId/api/v3.0';
/** Registry and discovery are per server, so they are not placed under the file path */
const REGISTRY_PREFIX = '/api/v3.0';
/** Paths we intentionally expose outside the spec */
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
  // Template requirement level — the "category" column of the value table (mandatory / optional). 2026-10-13
  '/packages/:packageId/requirements',
  // Type -> unit propagation (files created by splitting per unit). 2026-10-13
  '/packages/:packageId/derivation',
  '/packages/:packageId/derivation/apply',
  '/packages/:packageId/collect',
  '/packages/:packageId/aid',
  // Authoring-tool features — the spec has no "create new" (AasxFileServer only handles upload)
  '/packages/:packageId/diagram.svg',
  '/packages/:packageId/table',
  '/packages/:packageId/doc-plan',
  '/packages/:packageId/live',
  '/registry-conflicts',
  '/collect-status',
  '/packages/new',
  '/policy',
  '/rules',
  // Added 2026-09-03 — the 7 paths below were missing, so this script exited with code 1 for a while.
  // The gatekeeper was sounding and nobody noticed. When you add a new path, list it here too
  '/packages/:packageId/clone',
  '/packages/:packageId/history/:submodelId',
  '/packages/:packageId/history/:submodelId/restore',
  '/packages/:packageId/hierarchy',
  '/packages/:packageId/hierarchy/nodes',
  '/packages/:packageId/hierarchy/nodes/:name',
  '/opcua/browse',
  // 2026-09-30 — reference bundle (process file -> one complete submission package, reopen)
  '/packages/:packageId/bundle',
  '/packages/:packageId/bundle/linkage',
  '/bundles',
  '/packages/:packageId/bundle/files',
  // 2026-09-30 — connect to the built-in virtual PLC (for evaluators to reproduce)
  '/packages/:packageId/simulate',
  // 2026-10-02 — human login. The spec (Part 2) only defines machine-to-machine interfaces and does not cover
  //   human authentication. Tokens (API keys) are unchanged; only humans moved to sessions, so spec conformance is unaffected
  '/auth/me',
  '/auth/login',
  '/auth/logout',
  '/auth/setup',
  '/auth/signup',
  '/auth/users',
  '/auth/users/:userId',
  '/auth/password',
  // 2026-09-04 — undo / redo (per-package snapshots)
  '/packages/:packageId/undo',
  '/packages/:packageId/redo',
  // 2026-09-04 — reorder / duplicate elements (authoring operations not in the spec). Mounted under both prefixes
  '/packages/:packageId/api/v3.0/submodels/:identifier/submodel-elements/:path/move',
  '/packages/:packageId/api/v3.0/submodels/:identifier/submodel-elements/:path/duplicate',
  '/packages/:packageId/api/v3.0/shells/:identifier/submodels/:submodelIdentifier/submodel-elements/:path/move',
  '/packages/:packageId/api/v3.0/shells/:identifier/submodels/:submodelIdentifier/submodel-elements/:path/duplicate',
];

/** Extracts only (method, path, success code) from OpenAPI YAML — reads by indentation, no dependency */
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

/** Erases parameter-name differences: `/submodels/{submodelIdentifier}` == `/submodels/:identifier` */
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
  // If the success status code differs from the spec, clients break silently
  if (mine.success && !mine.success.includes(Number(entry.code))) {
    wrongCode.push({ key, expected: entry.code, actual: mine.success.join(',') });
  }
}

/**
 * Verifies that every profile advertised by /description is really fully implemented.
 * If the profile string is listed but an operation is missing, clients assume it exists, call it, and break.
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

// Coverage per profile — shows what is still needed to complete each profile
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
