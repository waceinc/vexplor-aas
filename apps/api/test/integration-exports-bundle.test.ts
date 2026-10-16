/**
 * Integration bundle (design §4.4): one zip with every export of the visible files. Each part must be exactly what the
 * single export route answers — the bundle is a carrier, never a second projection.
 */
import { createHash } from 'node:crypto';

import { unzipArchive } from '@aas/aasx';
import { describe, expect, it } from 'vitest';
import { EXPORT_SCHEMAS } from '../src/integration/exports/export-schemas.js';
import type { BundleManifest } from '../src/integration/routes-exports-bundle.js';
import { checkSchema, type JsonSchema } from '../src/integration/schema-check.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { FIXED_NOW, harness, plantFile, rollForming, unitAsset, unitCopy, type Json } from './helpers/integration-fixtures.js';

async function setup() {
  const store = createIntegrationStore();
  const type = await store.importPackage({ name: 'type.aasx', package: rollForming() });
  const unit = await store.importPackage({ name: 'unit-1.aasx', package: unitCopy(1) });
  await store.importPackage({ name: 'unit-2.aasx', package: unitCopy(2) });
  const plant = await store.importPackage({
    name: 'plant.aasx',
    package: plantFile([
      { name: 'RollForming_1', globalAssetId: unitAsset(1) },
      { name: 'RollForming_2', globalAssetId: unitAsset(2) },
    ]),
  });
  return { store, typeId: type.id, unitId: unit.id, plantId: plant.id, ...harness(store) };
}

const decode = (data: Uint8Array): Json => JSON.parse(new TextDecoder().decode(data)) as Json;

async function bundleOf(call: ReturnType<typeof harness>['call'], query: Record<string, string> = {}) {
  const response = await call('GET', '/integrations/exports/bundle', { query });
  expect(response.status).toBe(200);
  const entries = unzipArchive(response.body as Uint8Array);
  return { response, entries, manifest: decode(entries['manifest.json']!) as unknown as BundleManifest };
}

describe('integration bundle', () => {
  it('is a zip with a manifest that validates and lists every part with its sha256', async () => {
    const { call } = await setup();
    const { response, entries, manifest } = await bundleOf(call);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('vexplor.integrationBundle-1-2026-10-14.zip');
    expect(checkSchema(EXPORT_SCHEMAS['vexplor.integrationBundle/1']! as JsonSchema, manifest)).toEqual([]);
    expect(manifest.exportedAt).toBe(FIXED_NOW);
    // Every part listed is in the zip with the stated hash, and the zip holds nothing unlisted
    expect(Object.keys(entries).sort()).toEqual(['manifest.json', ...manifest.parts.map((part) => part.path)].sort());
    for (const part of manifest.parts) {
      expect(`sha256:${createHash('sha256').update(entries[part.path]!).digest('hex')}`).toBe(part.sha256);
      expect((decode(entries[part.path]!)['items'] as unknown[]).length).toBe(part.items);
    }
  });

  it('carries exactly what the single export routes answer', async () => {
    const { call, plantId } = await setup();
    const { entries, manifest } = await bundleOf(call);
    const equipment = await call('GET', '/integrations/exports/equipment', { query: { includeTypes: '1' } });
    expect(decode(entries['equipment.json']!)).toEqual(equipment.body);
    const hierarchy = await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId } });
    expect(decode(entries[`packages/${plantId}/hierarchy.json`]!)).toEqual(hierarchy.body);
    // Each part's envelope time is the manifest's — one frozen clock for the whole bundle
    for (const part of manifest.parts) expect(decode(entries[part.path]!)['exportedAt']).toBe(manifest.exportedAt);
  });

  it('covers Type, Instance and process files alike, and keeps Type shells in the equipment master', async () => {
    const { call, typeId, plantId } = await setup();
    const { entries, manifest } = await bundleOf(call);
    expect(manifest.packages.map((record) => record.name).sort()).toEqual(['plant.aasx', 'type.aasx', 'unit-1.aasx', 'unit-2.aasx']);
    // The process file has no Instance shell, yet its plant hierarchy is in the bundle
    expect(manifest.parts.some((part) => part.path === `packages/${plantId}/hierarchy.json`)).toBe(true);
    const items = decode(entries['equipment.json']!)['items'] as Json[];
    expect(items.some((item) => item['packageId'] === typeId && item['assetKind'] === 'Type')).toBe(true);
  });

  it('records a refused per-file export under skipped instead of failing', async () => {
    const { call, plantId } = await setup();
    const { manifest } = await bundleOf(call);
    const bom = manifest.skipped.find((entry) => entry.packageId === plantId && entry.kind === 'bom');
    expect(bom?.code).toBe('NoBom');
    expect(bom?.message).not.toBe('');
    // A part is either present or explained — never silently missing for hierarchy and BOM
    for (const record of manifest.packages) {
      for (const kind of ['hierarchy', 'bom'] as const) {
        const present = manifest.parts.some((part) => part.packageId === record.packageId && part.path.endsWith(`/${kind}.json`));
        const explained = manifest.skipped.some((entry) => entry.packageId === record.packageId && entry.kind === kind);
        expect(present !== explained).toBe(true);
      }
    }
  });

  it('narrows to one file with packageId and answers 404 for an unknown one', async () => {
    const { call, unitId } = await setup();
    const { manifest } = await bundleOf(call, { packageId: unitId });
    expect(manifest.packages.map((record) => record.packageId)).toEqual([unitId]);
    expect(manifest.parts.every((part) => part.packageId === null || part.packageId === unitId)).toBe(true);
    expect((await call('GET', '/integrations/exports/bundle', { query: { packageId: 'pkg_999' } })).status).toBe(404);
  });

  it('is byte-for-byte identical when nothing changed', async () => {
    const { call } = await setup();
    const first = (await call('GET', '/integrations/exports/bundle')).body as Uint8Array;
    const second = (await call('GET', '/integrations/exports/bundle')).body as Uint8Array;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
