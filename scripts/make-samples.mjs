/**
 * Builds the samples — the files a first-time user gets with a single "Start with a sample" click.
 *
 *   node scripts/make-samples.mjs        -> apps/web/public/samples/
 *
 * Outputs
 *   RollFormingMachine_sample.aasx              one machine (roll-forming machine — an anonymized test fixture)
 *   RB01_OptimizationQuality_sample_bundle.zip  reference bundle — process composition + the machine above x2
 *
 * Important: samples ship **after auto-fix has been applied**. The original fixture is an old version with idShort on
 *    list children (AASd-120), so the standard validator (aas-test-engines) rejects it with 9 errors and basyx reads
 *    only 99 of 175 elements (measured 2026-10-06). If the very first file looks like that, it reads as
 *    "files made by this tool do not meet the standard".
 * Important: do not modify the fixtures (tests/fixtures) — their "before fix" state is what the tests exercise.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readAasx } from '@aas/aasx';
import { createApi } from '@aas/api';
import { InMemoryStore } from '@aas/store';

const SOURCE = 'tests/fixtures/01-roll-forming-machine.aasx';
const OUT = 'apps/web/public/samples';
const MACHINE = 'RollFormingMachine_sample.aasx';
const PROCESS = 'RB01_OptimizationQuality_sample.aasx';
const BUNDLE = 'RB01_OptimizationQuality_sample_bundle.zip';

const store = new InMemoryStore();
await store.init();
const api = createApi(store);
const call = async (method, path, body, query = {}) => {
  const response = await api({
    method,
    path,
    query,
    queryAll: {},
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body } : {}),
  });
  if (response.status >= 400) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(response.body)}`);
  return response;
};

// (1) Machine — import and fix everything, warnings included
const machine = (await store.importPackage({ name: MACHINE, package: readAasx(new Uint8Array(readFileSync(SOURCE))) })).id;
const fixed = (await call('POST', `/packages/${machine}/fix`, {}, { includeWarnings: '1' })).body;
const after = fixed.after.countBySeverity;
if (after.error > 0 || after.warning > 0) {
  throw new Error(`Findings remain after fixing — ${after.error} violations · ${after.warning} warnings. Not shipping this as a sample`);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/${MACHINE}`, (await call('GET', `/packages/${machine}`)).body);

// (2) Process composition — create it, then re-import with _sample in the name ("create new" derives the name from the asset name)
const made = (await call('POST', '/packages/new', { assetName: 'RB01_OptimizationQuality', unit: 'composite' })).body.packageId;
await call('POST', `/packages/${made}/hierarchy/nodes`, { group: true, name: 'AutoPartsFormingProcess' });
await call('POST', `/packages/${made}/hierarchy/nodes`, { sourcePackageId: machine, parentPath: ['AutoPartsFormingProcess'], bulkCount: 2 });
const proc = (await store.importPackage({ name: PROCESS, package: await store.exportPackage(made) })).id;
await store.deletePackage(made);
const zip = await call('GET', `/packages/${proc}/bundle`, undefined, { code: 'RB01', version: '1.0.0' });
writeFileSync(`${OUT}/${BUNDLE}`, zip.body);

console.log(`Samples created → ${OUT}`);
console.log(`  ${MACHINE}  (${fixed.applied.length} fixes · 0 violations · 0 warnings)`);
console.log(`  ${BUNDLE}  (${zip.body.length.toLocaleString()} bytes)`);
