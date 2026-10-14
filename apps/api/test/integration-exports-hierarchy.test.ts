/**
 * Plant hierarchy export for MES (design §4.4, D19, INT-4): JSON / CSV round trip, WorkUnits carry their asset id,
 * ×n stays one row with a warning, ISA-95 overrides and stale overrides.
 */
import { parseCsv } from '@aas/linter';
import { describe, expect, it } from 'vitest';
import { HIERARCHY_V1_COLUMNS } from '../src/integration/exports/columns.js';
import { cellText } from '../src/integration/exports/csv.js';
import { EXPORT_SCHEMAS } from '../src/integration/exports/export-schemas.js';
import { hierarchyRow, type HierarchyItem } from '../src/integration/exports/hierarchy.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { expectGolden, harness, normalized, plantFile, text, unitAsset, unitCopy, type Json } from './helpers/integration-fixtures.js';
import { schemaErrors } from './helpers/schema-subset.js';

async function setup() {
  const store = createIntegrationStore();
  await store.importPackage({ name: 'unit-1.aasx', package: unitCopy(1) });
  await store.importPackage({ name: 'unit-2.aasx', package: unitCopy(2) });
  const plant = await store.importPackage({
    name: 'plant.aasx',
    package: plantFile([
      { name: 'RollForming_1', globalAssetId: unitAsset(1) },
      { name: 'RollForming_2', globalAssetId: unitAsset(2), bulkCount: 3 },
    ]),
  });
  return { store, plantId: plant.id, ...harness(store) };
}

const items = (body: unknown): HierarchyItem[] => (body as { items: HierarchyItem[] }).items;

describe('hierarchy export', () => {
  it('matches the golden JSON and CSV and validates against its schema', async () => {
    const { call, plantId } = await setup();
    const asJson = await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId } });
    expect(asJson.status).toBe(200);
    expect(schemaErrors(EXPORT_SCHEMAS['kr.vexplor.aas.hierarchy.v1']!, asJson.body)).toEqual([]);
    expectGolden('hierarchy.json', `${JSON.stringify(normalized(asJson.body), null, 2)}\n`);
    expectGolden('hierarchy.csv', text((await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId, format: 'csv' } })).body));
  });

  it('parses back from CSV to the JSON values', async () => {
    const { call, plantId } = await setup();
    const json = items((await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId } })).body);
    const [header, ...rows] = parseCsv(text((await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId, format: 'csv' } })).body));
    expect(header).toEqual([...HIERARCHY_V1_COLUMNS]);
    expect(rows).toEqual(json.map((item) => HIERARCHY_V1_COLUMNS.map((key) => cellText(hierarchyRow(item)[key]))));
  });

  it('gives every WorkUnit its asset id and the holder file, and keeps ×n as one row with INT-4', async () => {
    const { call, plantId } = await setup();
    const list = items((await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId } })).body);
    expect(list.map((item) => [item.id, item.equipmentLevel])).toEqual([
      ['SampleFactory', 'Enterprise'],
      ['SampleFactory/PressLine', 'Area'],
      ['SampleFactory/PressLine/Forming', 'WorkCenter'],
      ['SampleFactory/PressLine/Forming/RollForming_1', 'WorkUnit'],
      ['SampleFactory/PressLine/Forming/RollForming_2', 'WorkUnit'],
    ]);
    const units = list.filter((item) => item.equipmentLevel === 'WorkUnit');
    expect(units.every((item) => item.globalAssetId !== null && item.packageId !== null)).toBe(true);
    const second = units.find((item) => item.name === 'RollForming_2')!;
    expect(second.quantity).toBe(3);
    expect(second.serialNumber).toBe('EXM-RFL-2026-00128');
    expect(second.warnings.some((warning) => warning.startsWith('INT-4'))).toBe(true);
    expect(units.find((item) => item.name === 'RollForming_1')!.warnings).toEqual([]);
  });

  it('applies ISA-95 overrides and the site from the package config, and reports overrides whose node is gone', async () => {
    const { store, call, plantId } = await setup();
    await store.putPackageIntegrationConfig(plantId, {
      schema: 'vexplor.packageIntegrationConfig/1',
      isa95: { site: 'Changwon', levels: { 'SampleFactory/PressLine': 'Site', 'SampleFactory/OldLine': 'Area' } },
    });
    const body = (await call('GET', '/integrations/exports/hierarchy', { query: { packageId: plantId } })).body as Json;
    expect(body['site']).toBe('Changwon');
    expect(items(body).find((item) => item.id === 'SampleFactory/PressLine')!.equipmentLevel).toBe('Site');
    expect(body['warnings']).toEqual([expect.stringContaining('SampleFactory/OldLine')]);

    // The equipment master reads the same levels: the override wins over the configured site
    const equipment = ((await call('GET', '/integrations/exports/equipment')).body as { items: Json[] }).items;
    expect((equipment[0]!['location'] as Json)['isa95']).toEqual({ site: 'PressLine', area: null, workCenter: 'Forming' });

    // Without a Site node, the configured site fills it
    await store.putPackageIntegrationConfig(plantId, { schema: 'vexplor.packageIntegrationConfig/1', isa95: { site: 'Changwon' } }, 1);
    const placed = ((await call('GET', '/integrations/exports/equipment')).body as { items: Json[] }).items;
    expect((placed[0]!['location'] as Json)['isa95']).toEqual({ site: 'Changwon', area: 'PressLine', workCenter: 'Forming' });
  });

  it('answers 422 for a package without a hierarchy', async () => {
    const store = createIntegrationStore();
    const { environment } = unitCopy(1);
    (environment.submodels as unknown as Json[]).splice(
      (environment.submodels as unknown as Json[]).findIndex((sm) => sm['idShort'] === 'HierarchicalStructures'),
      1,
    );
    const pkg = await store.importPackage({ name: 'flat.aasx', package: { ...unitCopy(1), environment } });
    const response = await harness(store).call('GET', '/integrations/exports/hierarchy', { query: { packageId: pkg.id } });
    expect(response.status).toBe(422);
  });
});
