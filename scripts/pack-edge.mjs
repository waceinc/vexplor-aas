/**
 * Packs the remote collector (packages/edge) as one executable per platform, with its installer (plan R3).
 *
 *     npx tsc -b && node scripts/pack-edge.mjs             # → out/edge/vexplor-edge-<version>-linux-x64.tar.gz + SHA256SUMS
 *     npx tsc -b && node scripts/pack-edge.mjs --windows   # + vexplor-edge-<version>-win-x64.zip
 *     npx tsc -b && node scripts/pack-edge.mjs --arm64     # + vexplor-edge-<version>-linux-arm64.tar.gz (ARM servers, tests)
 *
 * 1. rolldown bundles packages/edge/dist/bin.js and everything it imports into one CommonJS file.
 * 2. The packages that actually went into the bundle become THIRD-PARTY-NOTICES.txt and a CycloneDX SBOM — the list is
 *    what was bundled, not what package.json declares.
 * 3. Node.js single executable (SEA): a blob made with the same Node version as the targets, injected with postject into
 *    the official Linux and Windows binaries. Every download is checked — Node against the official SHASUMS256.txt,
 *    WinSW against the hash pinned below.
 * 4. Each package holds the executable, the installer (install.sh + systemd unit / install.ps1 + WinSW), an example
 *    configuration, LICENSE, NOTICE, the notices and the SBOM.
 *
 * Important: Windows is built only with --windows — it is not offered yet (installed on no Windows PC so far; the
 *    guide says Windows will be covered later). Releases ship Linux only until then.
 * Important: the Windows executable is not code-signed — signing needs a certificate (a purchase; plan §10-4). Until
 *    then the package is verified by SHA256SUMS.
 * Important: WinSW publishes no digest for v2.12.0; the hash below was taken at its first download (2026-10-16) and is
 *    the one every later build must match.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { zipSync } from 'fflate';
import { rolldown } from 'rolldown';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'out/edge');
const CACHE = join(OUT, 'cache');
const NODE_VERSION = 'v24.21.0'; // Node 24 LTS, the newest patch at least two weeks old when chosen (2026-10-16)
const WINSW = { url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe', sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da' };
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
/** Packages whose package.json names no license, read from their own files (2026-10-16) */
const LICENSE_READ = { dequeue: 'BSD-2-Clause' /* LICENSE file */, precond: 'MIT' /* README "License" */ };
/** Runtime copyleft is refused (scripts/ci.sh step 7 holds the server to the same rule) */
const REFUSED_LICENSE = /GPL|SSPL|BUSL|Commons-Clause/i;

const version = /PRODUCT_VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'packages/aas-core/src/version.ts'), 'utf8'))[1];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (message) => {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
};

async function download(url, file) {
  if (existsSync(file)) return file;
  const response = await fetch(url);
  if (!response.ok) fail(`download ${url}: ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

/** Bundles the edge and returns the bundled third-party packages */
async function bundle(file) {
  if (!existsSync(join(ROOT, 'packages/edge/dist/bin.js'))) fail('packages/edge/dist is missing — run npx tsc -b first');
  const build = await rolldown({ input: join(ROOT, 'packages/edge/dist/bin.js'), platform: 'node', external: (id) => id.startsWith('node:'), logLevel: 'silent', treeshake: true });
  const { output } = await build.generate({ format: 'cjs', codeSplitting: false });
  await build.close();
  writeFileSync(file, output[0].code);
  const packages = new Map();
  for (const id of Object.keys(output[0].modules)) {
    const at = id.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const rest = id.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (packages.has(name)) continue;
    const manifest = JSON.parse(readFileSync(join(id.slice(0, at), 'node_modules', name, 'package.json'), 'utf8'));
    const license = typeof manifest.license === 'string' ? manifest.license : LICENSE_READ[name];
    // An unknown license is a question for a person, not a line in a notices file
    if (!license) fail(`${name}@${manifest.version}: no license in package.json — read it and add it to LICENSE_READ`);
    if (REFUSED_LICENSE.test(license)) fail(`${name}@${manifest.version} is ${license} — not allowed in the edge package`);
    packages.set(name, { name, version: manifest.version, license });
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function notices(packages, extra) {
  const lines = [`VEXPLOR Edge ${version} — third-party software in this package`, ''];
  for (const entry of [...packages, ...extra]) lines.push(`${entry.name} ${entry.version} — ${entry.license}`);
  return `${lines.join('\n')}\n`;
}

function sbom(packages, extra) {
  return JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: { component: { type: 'application', name: 'vexplor-edge', version } },
      components: [...packages, ...extra].map((entry) => ({ type: 'library', name: entry.name, version: entry.version, licenses: [{ license: { id: entry.license } }] })),
    },
    null,
    2,
  );
}

/** Downloads and checks the official Node binary for one platform; returns the path of node / node.exe */
async function nodeBinary(platform, sums) {
  const archive = platform === 'win-x64' ? `node-${NODE_VERSION}-win-x64.zip` : `node-${NODE_VERSION}-${platform}.tar.gz`;
  const file = await download(`https://nodejs.org/dist/${NODE_VERSION}/${archive}`, join(CACHE, archive));
  const expected = sums.get(archive);
  if (!expected || sha256(file) !== expected) fail(`${archive} does not match SHASUMS256.txt`);
  const dir = join(CACHE, archive.replace(/\.(zip|tar\.gz)$/, ''));
  if (!existsSync(dir)) execFileSync('tar', ['-xf', file, '-C', CACHE]);
  return platform === 'win-x64' ? join(dir, 'node.exe') : join(dir, 'bin/node');
}

const archiveOf = (dir) => {
  const entries = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const executable = (statSync(path).mode & 0o111) !== 0;
    entries[`vexplor-edge-${version}/${name}`] = [readFileSync(path), { level: 9, os: 3, attrs: (executable ? 0o755 : 0o644) << 16 }];
  }
  return zipSync(entries);
};

rmSync(join(OUT, 'build'), { recursive: true, force: true });
mkdirSync(join(OUT, 'build'), { recursive: true });
mkdirSync(CACHE, { recursive: true });
const bundled = join(OUT, 'build/vexplor-edge.cjs');
const packages = await bundle(bundled);

const sumsFile = await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, join(CACHE, `SHASUMS256-${NODE_VERSION}.txt`));
const sums = new Map(readFileSync(sumsFile, 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()));
const hostPlatform = `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`;
const hostNode = await nodeBinary(hostPlatform, sums);

// The SEA blob is made by the very Node version that runs it
const blob = join(OUT, 'build/sea-prep.blob');
writeFileSync(join(OUT, 'build/sea-config.json'), JSON.stringify({ main: bundled, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(hostNode, ['--experimental-sea-config', join(OUT, 'build/sea-config.json')], { stdio: 'ignore' });

const winsw = await download(WINSW.url, join(CACHE, 'WinSW-x64-2.12.0.exe'));
if (sha256(winsw) !== WINSW.sha256) fail('WinSW-x64.exe does not match the pinned hash');
const nodeEntry = { name: 'node', version: NODE_VERSION.slice(1), license: 'MIT' };
const winswEntry = { name: 'winsw', version: '2.12.0', license: 'MIT' };
const results = [];

const platforms = ['linux-x64', ...(process.argv.includes('--arm64') ? ['linux-arm64'] : []), ...(process.argv.includes('--windows') ? ['win-x64'] : [])];
for (const platform of platforms) {
  // The folder already carries its final name — no tar renaming flags (GNU and BSD tar differ)
  const stage = join(OUT, 'build', platform, `vexplor-edge-${version}`);
  mkdirSync(stage, { recursive: true });
  const exe = join(stage, platform === 'win-x64' ? 'vexplor-edge.exe' : 'vexplor-edge');
  copyFileSync(await nodeBinary(platform, sums), exe);
  chmodSync(exe, 0o755);
  execFileSync(join(ROOT, 'node_modules/.bin/postject'), [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE, ...(platform === 'win-x64' ? ['--overwrite'] : [])], { stdio: 'ignore' });
  const install = join(ROOT, 'packages/edge/install');
  const extra = platform === 'win-x64' ? [nodeEntry, winswEntry] : [nodeEntry];
  if (platform === 'win-x64') {
    copyFileSync(winsw, join(stage, 'vexplor-edge-service.exe'));
    copyFileSync(join(install, 'vexplor-edge-service.xml'), join(stage, 'vexplor-edge-service.xml'));
    copyFileSync(join(install, 'install.ps1'), join(stage, 'install.ps1'));
  } else {
    copyFileSync(join(install, 'install.sh'), join(stage, 'install.sh'));
    chmodSync(join(stage, 'install.sh'), 0o755);
    copyFileSync(join(install, 'vexplor-edge.service'), join(stage, 'vexplor-edge.service'));
  }
  writeFileSync(join(stage, 'edge.example.json'), `${JSON.stringify({ server: 'https://aas.example.com', stateDir: platform === 'win-x64' ? 'C:/ProgramData/VEXPLOR Edge/state' : '/var/lib/vexplor-edge', proxy: 'http://proxy.plant.local:3128' }, null, 2)}\n`);
  copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  copyFileSync(join(ROOT, 'NOTICE'), join(stage, 'NOTICE'));
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices(packages, extra));
  writeFileSync(join(stage, 'sbom.cdx.json'), sbom(packages, extra));
  const name = `vexplor-edge-${version}-${platform}.${platform === 'win-x64' ? 'zip' : 'tar.gz'}`;
  if (platform === 'win-x64') writeFileSync(join(OUT, name), archiveOf(stage));
  else execFileSync('tar', ['--no-xattrs', '-czf', join(OUT, name), '-C', join(OUT, 'build', platform), `vexplor-edge-${version}`], { stdio: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  results.push(name);
}

writeFileSync(join(OUT, 'SHA256SUMS'), results.map((name) => `${sha256(join(OUT, name))}  ${name}`).join('\n') + '\n');
process.stdout.write(`[OK] ${results.join(', ')} — ${packages.length} bundled packages, Node ${NODE_VERSION}\n`);
