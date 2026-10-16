/**
 * `buildBundle` (the `@aas/bundle` tarball): the same bundle as `GET /integrations/exports/bundle`, without a server.
 *
 * The committed sample under docs/examples/integration-bundle/ is what another product runs its import gate on. It is
 * checked here byte for byte, so it can never drift from what the code builds. After a deliberate change (a new field,
 * a version bump) regenerate it with:
 *
 *     AAS_UPDATE_SAMPLES=1 npx vitest run apps/api/test/integration-bundle-build.test.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { writeAasx } from '@aas/aasx';
import { describe, expect, it } from 'vitest';
import { BundleBuildError, buildBundle, type BundleInput } from '../src/integration/bundle-build.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { FIXED_NOW, harness, plantFile, rollForming, unitAsset, unitCopy } from './helpers/integration-fixtures.js';

const SAMPLE_DIR = 'docs/examples/integration-bundle';
const SAMPLE_TIME = '2026-10-16T00:00:00.000Z';
/** Upload order = package ids pkg_1 … pkg_4 */
const SAMPLE_NAMES = ['RollFormingMachine_Type.aasx', 'RollFormingMachine_1.aasx', 'RollFormingMachine_2.aasx', 'SampleFactory.aasx'];
const updating = process.env['AAS_UPDATE_SAMPLES'] === '1';

/** The sample inputs: a Type, two Instances made from it, and a company file placing both units on a line */
function generateInputs(): BundleInput[] {
  const packages = [
    rollForming(),
    unitCopy(1),
    unitCopy(2),
    plantFile([
      { name: 'RollForming_1', globalAssetId: unitAsset(1) },
      { name: 'RollForming_2', globalAssetId: unitAsset(2) },
    ]),
  ];
  return packages.map((pkg, index) => ({ name: SAMPLE_NAMES[index]!, data: writeAasx(pkg) }));
}

function sampleInputs(): BundleInput[] {
  return SAMPLE_NAMES.map((name) => ({ name, data: new Uint8Array(readFileSync(`${SAMPLE_DIR}/${name}`)) }));
}

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

if (updating) {
  mkdirSync(SAMPLE_DIR, { recursive: true });
  for (const input of generateInputs()) writeFileSync(`${SAMPLE_DIR}/${input.name}`, input.data);
  const { zip } = await buildBundle(sampleInputs(), { exportedAt: SAMPLE_TIME });
  writeFileSync(`${SAMPLE_DIR}/vexplor.integrationBundle-1-sample.zip`, zip);
}

describe('buildBundle', () => {
  it('gives the same bytes as the API route for the same files and clock', async () => {
    const inputs = sampleInputs();
    const { call } = harness(createIntegrationStore());
    for (const input of inputs) {
      const upload = await call('POST', '/packages', {
        query: { name: input.name },
        body: input.data,
        headers: { 'content-type': 'application/asset-administration-shell-package' },
      });
      expect(upload.status).toBe(201);
    }
    const api = (await call('GET', '/integrations/exports/bundle')).body as Uint8Array;
    const built = await buildBundle(inputs, { exportedAt: FIXED_NOW });
    expect(sha(built.zip)).toBe(sha(api));
  });

  it('matches the committed sample bundle byte for byte', async () => {
    const committed = new Uint8Array(readFileSync(`${SAMPLE_DIR}/vexplor.integrationBundle-1-sample.zip`));
    const { zip } = await buildBundle(sampleInputs(), { exportedAt: SAMPLE_TIME });
    // On failure: regenerate with AAS_UPDATE_SAMPLES=1 (see the file header) and review the diff before committing
    expect(sha(zip)).toBe(sha(committed));
  });

  it('carries the Type, both units and the plant hierarchy in the sample', async () => {
    const { manifest, files } = await buildBundle(sampleInputs(), { exportedAt: SAMPLE_TIME });
    expect(manifest.packages.map((record) => record.name)).toEqual(SAMPLE_NAMES);
    const equipment = JSON.parse(new TextDecoder().decode(files['equipment.json'])) as { items: { assetKind: string }[] };
    expect(equipment.items.map((item) => item.assetKind).sort()).toEqual(['Instance', 'Instance', 'Type']);
    // The company file (pkg_4) has no Instance shell, yet its hierarchy is in the bundle
    expect(manifest.parts.some((part) => part.path === 'packages/pkg_4/hierarchy.json')).toBe(true);
    for (const part of manifest.parts) expect(`sha256:${sha(files[part.path]!)}`).toBe(part.sha256);
  });

  it('passes language and instance id into every part', async () => {
    const { manifest, files } = await buildBundle(sampleInputs(), { exportedAt: SAMPLE_TIME, lang: 'en', instanceId: 'abcdef012345' });
    expect(manifest.language).toBe('en');
    expect(manifest.source.instanceId).toBe('abcdef012345');
    const equipment = JSON.parse(new TextDecoder().decode(files['equipment.json'])) as { language: string; source: { instanceId: string } };
    expect(equipment.language).toBe('en');
    expect(equipment.source.instanceId).toBe('abcdef012345');
  });

  it('names the file it cannot read, and refuses an empty list', async () => {
    const broken = buildBundle([{ name: 'broken.aasx', data: new TextEncoder().encode('not a zip') }]);
    await expect(broken).rejects.toBeInstanceOf(BundleBuildError);
    await expect(broken).rejects.toMatchObject({ code: 'BadRequest', fileName: 'broken.aasx' });
    await expect(buildBundle([])).rejects.toMatchObject({ code: 'BadRequest' });
  });
});
