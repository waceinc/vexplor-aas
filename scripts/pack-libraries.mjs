/**
 * Packs the reusable libraries — the AAS model, AASX reading/writing and the validation rules — as npm tarballs that
 * another product installs **from the GitHub release**, without a registry.
 *
 *     npx tsc -b && node scripts/pack-libraries.mjs                 # → out/libraries/*.tgz + SHA256SUMS
 *     node scripts/pack-libraries.mjs --verify                     # + install them in an empty project and run them
 *     node scripts/pack-libraries.mjs --version 2.0.2               # default: PRODUCT_VERSION in packages/aas-core
 *
 * Attach the tarballs to the release `v<version>`; a consumer then writes, for example,
 *     "@aas/aasx": "https://github.com/waceinc/vexplor-aas/releases/download/v2.0.2/aas-aasx-2.0.2.tgz"
 *
 * Important: **install by release URL, never by version number.** The `@aas` scope is not ours on the public npm
 *    registry. A dependency written as `"@aas/core": "^2.0.0"` would be looked up there, and whoever registers that
 *    name decides what runs. That is why every internal dependency inside the tarballs is rewritten to the release
 *    URL too — a consumer that pins one URL never reaches the registry for the others.
 * Important: the tarballs carry the product version (one number for the server, the UI and the libraries), not the
 *    workspace `0.1.0`. "Which version are you on" has to have one answer.
 * Important: only `dist/` (built code with types), LICENSE and NOTICE go in. Sources stay in the repository; test
 *    output and build info files are left out.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'out/libraries');
const REPOSITORY = 'https://github.com/waceinc/vexplor-aas';

/** What another product may build on. Order matters: a package comes after the ones it depends on */
const LIBRARIES = [
  { name: '@aas/core', dir: 'packages/aas-core' },
  { name: '@aas/aasx', dir: 'packages/aasx' },
  { name: '@aas/linter', dir: 'packages/linter' },
];

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const verify = args.includes('--verify');
const version = versionAt >= 0 ? args[versionAt + 1] : productVersion();
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(`not a version: ${version}`);

const fileOf = (name) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const releaseUrl = (name) => `${REPOSITORY}/releases/download/v${version}/${fileOf(name)}`;

function productVersion() {
  const text = readFileSync(join(ROOT, 'packages/aas-core/src/version.ts'), 'utf8');
  return /PRODUCT_VERSION = '([^']+)'/.exec(text)?.[1];
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The published package.json — no workspace leftovers, internal dependencies pointed at `locate(name)` */
function manifestOf(source, locate) {
  const internal = new Set(LIBRARIES.map((library) => library.name));
  const dependencies = {};
  for (const [name, range] of Object.entries(source.dependencies ?? {})) {
    if (name.startsWith('@aas/') && !internal.has(name)) fail(`${source.name} depends on ${name}, which is not packed`);
    dependencies[name] = internal.has(name) ? locate(name) : range;
  }
  return {
    name: source.name,
    version,
    description: source.description,
    license: source.license,
    author: 'WACE',
    repository: { type: 'git', url: `${REPOSITORY}.git` },
    homepage: REPOSITORY,
    type: source.type,
    main: source.main,
    types: source.types,
    exports: source.exports,
    files: ['dist', 'LICENSE', 'NOTICE'],
    engines: { node: '>=22' },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };
}

/** Builds every tarball into `outDir`, internal dependencies pointed at `locate(name)` */
function pack(outDir, locate) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const stage = join(outDir, '.stage');
  for (const library of LIBRARIES) {
    const dir = join(ROOT, library.dir);
    if (!existsSync(join(dir, 'dist/index.js'))) fail(`${library.dir}/dist is missing — run npx tsc -b first`);
    const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (source.name !== library.name) fail(`${library.dir} is ${source.name}, expected ${library.name}`);
    const target = join(stage, library.dir.split('/').pop());
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(join(dir, 'dist'), join(target, 'dist'), {
      recursive: true,
      filter: (path) => !path.endsWith('.tsbuildinfo'),
    });
    cpSync(join(ROOT, 'LICENSE'), join(target, 'LICENSE'));
    cpSync(join(ROOT, 'NOTICE'), join(target, 'NOTICE'));
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifestOf(source, locate), null, 2)}\n`);
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', outDir], { cwd: target, encoding: 'utf8' }).trim().split('\n').pop();
    if (packed !== fileOf(library.name)) fail(`npm pack wrote ${packed}, expected ${fileOf(library.name)}`);
  }
  rmSync(stage, { recursive: true, force: true });
  const files = readdirSync(outDir).filter((name) => name.endsWith('.tgz')).sort();
  if (files.length !== LIBRARIES.length) fail(`expected ${LIBRARIES.length} tarballs, found ${files.length}`);
  writeFileSync(join(outDir, 'SHA256SUMS'), files.map((name) => `${sha256(join(outDir, name))}  ${name}`).join('\n') + '\n');
  return files;
}

const files = pack(OUT, releaseUrl);
console.log(`[OK] ${files.length} libraries, version ${version} → ${OUT}`);
for (const name of files) console.log(`     ${name}`);

if (verify) {
  // Important: the release tarballs point at URLs that exist only after the release is published. So the check packs a
  //    second set pointing at local files, installs that into an empty project **with the registry switched off for
  //    @aas** and runs it — proving the tarballs are complete and self-contained, not that the URLs answer.
  const local = join(ROOT, 'out/libraries-verify');
  const tarballs = join(local, 'tarballs');
  pack(tarballs, (name) => `file:${join(tarballs, fileOf(name))}`);
  const project = join(local, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'verify', private: true, type: 'module', dependencies: Object.fromEntries(LIBRARIES.map((library) => [library.name, `file:${join(tarballs, fileOf(library.name))}`])) }, null, 2),
  );
  // Any attempt to fetch @aas/* from a registry fails instead of silently pulling someone else's package
  writeFileSync(join(project, '.npmrc'), '@aas:registry=http://127.0.0.1:9/\n');
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: project, stdio: 'inherit' });
  const fixture = join(ROOT, 'tests/fixtures/01-roll-forming-machine.aasx');
  writeFileSync(
    join(project, 'check.mjs'),
    `import { readFileSync } from 'node:fs';
import { PRODUCT_VERSION } from '@aas/core';
import { readAasx } from '@aas/aasx';
import { ALL_RULES, lint } from '@aas/linter';
const pkg = readAasx(new Uint8Array(readFileSync(${JSON.stringify(fixture)})));
const shells = pkg.environment.assetAdministrationShells ?? [];
const result = lint(pkg.environment, ALL_RULES);
if (shells.length === 0) throw new Error('no shells read');
if (ALL_RULES.length === 0 || !Array.isArray(result.findings)) throw new Error('the rules did not run');
console.log(JSON.stringify({ version: PRODUCT_VERSION, shells: shells.length, rules: ALL_RULES.length, findings: result.findings.length }));
`,
  );
  const result = execFileSync('node', ['check.mjs'], { cwd: project, encoding: 'utf8' }).trim();
  console.log(`[OK] installed from tarballs alone and ran: ${result}`);
  rmSync(local, { recursive: true, force: true });
}
