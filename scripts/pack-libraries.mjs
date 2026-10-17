/**
 * Packs the reusable libraries — the AAS model, AASX reading/writing, the validation rules, the integration bundle
 * builder and the equipment readers (AID, OPC UA, Modbus TCP, MQTT) — as npm tarballs that another product installs
 * **from the GitHub release**, without a registry. The remote collector (github.com/waceinc/vexplor-edge) is built on
 * the readers, so it reads equipment exactly as this server's own collector does.
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
 * Important: `@aas/bundle` is not a workspace package. It is the API's own integration code (`buildBundle`, the very
 *    export routes the server mounts) bundled into one file with rolldown, so a product without an AAS Studio server
 *    gets the same bundle bytes — and the server code stays the one place that projects it. Only `@aas/core`,
 *    `@aas/aasx`, `@aas/linter` and `node:` built-ins may stay as imports; anything else ending up as an import means
 *    the bundle would need a package it does not declare, and packing fails.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { rolldown } from 'rolldown';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'out/libraries');
const REPOSITORY = 'https://github.com/waceinc/vexplor-aas';

/** What another product may build on. Order matters: a package comes after the ones it depends on */
const LIBRARIES = [
  { name: '@aas/core', dir: 'packages/aas-core' },
  { name: '@aas/aasx', dir: 'packages/aasx' },
  { name: '@aas/linter', dir: 'packages/linter' },
  { name: '@aas/collector', dir: 'packages/collector' },
  { name: '@aas/fieldbus', dir: 'packages/fieldbus' },
  { name: '@aas/opcua', dir: 'packages/opcua' },
  {
    name: '@aas/bundle',
    bundled: {
      entry: 'apps/api/dist/integration/bundle-build.js',
      // The declaration files shipped as emitted — the first becomes dist/index.d.ts
      types: ['apps/api/dist/integration/bundle-build.d.ts', 'apps/api/dist/integration/bundle-types.d.ts'],
      description: 'VEXPLOR integration bundle (vexplor.integrationBundle/1) built from AASX files, without a server',
      license: 'Apache-2.0',
      dependencies: ['@aas/core', '@aas/aasx', '@aas/linter'],
    },
  },
];
/** What the bundled code may still import */
const BUNDLE_EXTERNAL = (id) => id.startsWith('node:') || /^@aas\/(core|aasx|linter)$/.test(id);

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

/** Stages `@aas/bundle`: one ESM file from the API's integration code, plus its two declaration files */
async function stageBundled(library, target) {
  const { entry, types } = library.bundled;
  if (!existsSync(join(ROOT, entry))) fail(`${entry} is missing — run npx tsc -b first`);
  const build = await rolldown({ input: join(ROOT, entry), external: BUNDLE_EXTERNAL, platform: 'node', treeshake: true, logLevel: 'silent' });
  const { output } = await build.generate({ format: 'esm' });
  await build.close();
  if (output.length !== 1) fail(`${library.name}: expected one bundled file, got ${output.length}`);
  const code = output[0].code;
  const imports = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? match[2]);
  const stray = [...new Set(imports.filter((id) => !BUNDLE_EXTERNAL(id)))];
  if (stray.length > 0) fail(`${library.name}: the bundled code still imports ${stray.join(', ')}`);
  mkdirSync(join(target, 'dist'), { recursive: true });
  writeFileSync(join(target, 'dist/index.js'), code);
  types.forEach((file, index) => {
    const text = readFileSync(join(ROOT, file), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    // A relative import other than the shipped sibling would point at a file the tarball does not carry
    const relative = [...text.matchAll(/from\s*['"](\.[^'"]*)['"]/g)].map((match) => match[1]).filter((id) => id !== './bundle-types.js');
    if (relative.length > 0) fail(`${file} imports ${relative.join(', ')}, which the tarball does not carry`);
    writeFileSync(join(target, 'dist', index === 0 ? 'index.d.ts' : file.split('/').pop()), text);
  });
}

/** package.json of the bundled library — written here, it has no workspace package.json of its own */
function bundledSource(library) {
  const { description, license, dependencies } = library.bundled;
  return {
    name: library.name,
    description,
    license,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: Object.fromEntries(dependencies.map((name) => [name, version])),
  };
}

/** Builds every tarball into `outDir`, internal dependencies pointed at `locate(name)` */
async function pack(outDir, locate) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const stage = join(outDir, '.stage');
  for (const library of LIBRARIES) {
    const target = join(stage, library.name.split('/').pop());
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    let source;
    if (library.bundled) {
      await stageBundled(library, target);
      source = bundledSource(library);
    } else {
      const dir = join(ROOT, library.dir);
      if (!existsSync(join(dir, 'dist/index.js'))) fail(`${library.dir}/dist is missing — run npx tsc -b first`);
      source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (source.name !== library.name) fail(`${library.dir} is ${source.name}, expected ${library.name}`);
      cpSync(join(dir, 'dist'), join(target, 'dist'), {
        recursive: true,
        filter: (path) => !path.endsWith('.tsbuildinfo'),
      });
    }
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

const files = await pack(OUT, releaseUrl);
console.log(`[OK] ${files.length} libraries, version ${version} → ${OUT}`);
for (const name of files) console.log(`     ${name}`);

if (verify) {
  // Important: the release tarballs point at URLs that exist only after the release is published. So the check packs a
  //    second set pointing at local files, installs that into an empty project **with the registry switched off for
  //    @aas** and runs it — proving the tarballs are complete and self-contained, not that the URLs answer.
  const local = join(ROOT, 'out/libraries-verify');
  const tarballs = join(local, 'tarballs');
  await pack(tarballs, (name) => `file:${join(tarballs, fileOf(name))}`);
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
import { aidReadList, buildBundle } from '@aas/bundle';
import { buildAidSubmodel } from '@aas/collector';
import { ModbusReader, MqttReader } from '@aas/fieldbus';
import { OpcUaReader } from '@aas/opcua';
const pkg = readAasx(new Uint8Array(readFileSync(${JSON.stringify(fixture)})));
const shells = pkg.environment.assetAdministrationShells ?? [];
const result = lint(pkg.environment, ALL_RULES);
if (shells.length === 0) throw new Error('no shells read');
if (ALL_RULES.length === 0 || !Array.isArray(result.findings)) throw new Error('the rules did not run');
const bundle = await buildBundle([{ name: 'unit.aasx', data: new Uint8Array(readFileSync(${JSON.stringify(fixture)})) }], { exportedAt: '2026-01-01T00:00:00.000Z' });
if (bundle.manifest.schema !== 'vexplor.integrationBundle/1' || !bundle.files['equipment.json']) throw new Error('no bundle built');
const readList = aidReadList(pkg.environment, 'pkg_1');
if (!Array.isArray(readList)) throw new Error('aidReadList did not run');
// The readers the remote collector is built on: an AID from tags, and one reader per protocol
const aid = buildAidSubmodel({ assetName: 'Unit', iriBase: 'https://example.com/ids', endpoint: 'opc.tcp://127.0.0.1:4840', tags: [{ name: 'Speed', href: 'ns=2;s=Speed', type: 'float' }] });
pkg.environment.submodels.push(aid);
const aidList = aidReadList(pkg.environment, 'pkg_1');
if (aidList.length !== 1 || aidList[0].tags.length !== 1) throw new Error('the AID built by @aas/collector was not read back');
for (const [name, reader] of Object.entries({ OpcUaReader, ModbusReader, MqttReader })) if (typeof reader?.connect !== 'function') throw new Error(name + ' missing');
console.log(JSON.stringify({ version: PRODUCT_VERSION, shells: shells.length, rules: ALL_RULES.length, findings: result.findings.length, bundleParts: bundle.manifest.parts.length, readListInterfaces: readList.length, readers: 3 }));
`,
  );
  const result = execFileSync('node', ['check.mjs'], { cwd: project, encoding: 'utf8' }).trim();
  console.log(`[OK] installed from tarballs alone and ran: ${result}`);
  rmSync(local, { recursive: true, force: true });
}
