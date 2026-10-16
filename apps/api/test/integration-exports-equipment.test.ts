/**
 * Equipment master and BOM exports (design §4.4; ERP E-1, E-2, E-3, E-5, E-9, E-10, E-11, E-12, E-14).
 */
import { describe, expect, it } from 'vitest';
import {
  BOM_V1_COLUMNS,
  DOCUMENTS_V1_COLUMNS,
  EQUIPMENT_V1_COLUMNS,
  HIERARCHY_V1_COLUMNS,
  MAINTENANCE_V1_COLUMNS,
} from '../src/integration/exports/columns.js';
import { EXPORT_SCHEMAS } from '../src/integration/exports/export-schemas.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import {
  element,
  expectGolden,
  harness,
  normalized,
  plantFile,
  rollForming,
  shell,
  submodel,
  text,
  TYPE_ASSET,
  unitAsset,
  unitCopy,
  type Json,
} from './helpers/integration-fixtures.js';
import { checkSchema, type JsonSchema } from '../src/integration/schema-check.js';
import { derivationFile, newDerivation } from '../src/routes/derivation.js';

async function setup(packages = [unitCopy()]) {
  const store = createIntegrationStore();
  const ids: string[] = [];
  for (const [i, pkg] of packages.entries()) ids.push((await store.importPackage({ name: `file-${i}.aasx`, package: pkg })).id);
  return { store, ids, ...harness(store) };
}

const items = (body: unknown): Json[] => (body as { items: Json[] }).items;

describe('frozen CSV columns (E-2)', () => {
  // Important: a copy, not the constant — this test fails when someone edits a column list
  it('equal the v1 contract', () => {
    expect([...EQUIPMENT_V1_COLUMNS]).toEqual([
      'key', 'aasId', 'assetKind', 'typeAasId', 'packageId', 'revision', 'nameplate.manufacturer', 'nameplate.productDesignation',
      'nameplate.productFamily', 'nameplate.modelNumber', 'nameplate.orderCode', 'nameplate.serialNumber', 'nameplate.yearOfConstruction',
      'nameplate.dateOfManufacture', 'nameplate.productUri', 'nameplate.markings', 'physical.weight.value', 'physical.weight.unit',
      'location.path', 'location.isa95.site', 'location.isa95.area', 'location.isa95.workCenter', 'specificAssetIds', 'externalRefs',
      'missing', 'warnings',
    ]);
    expect([...BOM_V1_COLUMNS]).toEqual(['rootKey', 'parentPath', 'childPath', 'childName', 'childGlobalAssetId', 'quantity', 'level', 'entityType', 'erpMaterial', 'mapped']);
    expect([...HIERARCHY_V1_COLUMNS]).toEqual(['id', 'parentId', 'equipmentLevel', 'name', 'globalAssetId', 'aasId', 'packageId', 'serialNumber', 'quantity', 'specificAssetIds', 'warnings']);
    expect([...MAINTENANCE_V1_COLUMNS]).toEqual([
      'maintenanceId', 'taskName', 'interval', 'intervalStatus', 'technicians', 'qualification', 'safety', 'stepSeq', 'stepId', 'stepName',
      'instruction', 'durationValue', 'durationUnit', 'toolIds', 'consumableIds', 'documents', 'signatureRequired', 'sourceRef',
    ]);
    expect([...DOCUMENTS_V1_COLUMNS]).toEqual([
      'documentId', 'documentDomainId', 'classId', 'className', 'classificationSystem', 'version', 'language', 'title', 'status',
      'statusDate', 'issuer', 'fileName', 'contentType', 'size', 'sha256', 'available', 'url',
    ]);
  });
});

describe('equipment master', () => {
  it('matches the golden JSON and CSV for the Instance unit (E-1) and validates against its schema (E-3)', async () => {
    const { call } = await setup();
    const asJson = await call('GET', '/integrations/exports/equipment');
    expect(asJson.status).toBe(200);
    expect(checkSchema(EXPORT_SCHEMAS['vexplor.equipmentMaster/1']! as JsonSchema, asJson.body)).toEqual([]);
    expectGolden('equipment.json', `${JSON.stringify(normalized(asJson.body), null, 2)}\n`);
    const asCsv = await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } });
    expect(asCsv.headers['content-disposition']).toBe('attachment; filename="vexplor.equipmentMaster-1-2026-10-14.csv"');
    expectGolden('equipment.csv', text(asCsv.body));
  });

  it('exports the same bytes twice (E-5)', async () => {
    const { call } = await setup([unitCopy(2), unitCopy(1)]);
    const first = await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } });
    const second = await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } });
    expect(text(first.body)).toBe(text(second.body));
    // ordered by key, not by upload order
    expect(items((await call('GET', '/integrations/exports/equipment')).body).map((item) => item['key'])).toEqual([unitAsset(1), unitAsset(2)]);
  });

  it('excludes the Type fixture with the INT-1 reason, and flags it with includeTypes=1', async () => {
    const { call } = await setup([rollForming()]);
    const plain = (await call('GET', '/integrations/exports/equipment')).body as Json;
    expect(plain['items']).toEqual([]);
    expect((plain['excluded'] as Json[])[0]!['reason']).toMatch(/^INT-1/);
    const withTypes = items((await call('GET', '/integrations/exports/equipment', { query: { includeTypes: '1' } })).body);
    expect(withTypes).toHaveLength(1);
    expect(withTypes[0]!['key']).toBe(TYPE_ASSET);
    expect(withTypes[0]!['assetKind']).toBe('Type');
    expect((withTypes[0]!['warnings'] as string[])[0]).toMatch(/^INT-1/);
  });

  it('takes the unit from the ConceptDescription, else null + missing (E-11)', async () => {
    const without = items((await (await setup()).call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect((without['physical'] as Json)['weight']).toEqual({ value: 8500, unit: null });
    expect(without['missing']).toContain('physical.weight.unit');

    const withUnit = unitCopy(1, (env) => {
      const cd = (env.conceptDescriptions as unknown as Json[]).find((c) => c['id'] === '0173-1#02-AAQ808#007')!;
      const content = ((cd['embeddedDataSpecifications'] as Json[])[0]!['dataSpecificationContent']) as Json;
      content['unit'] = 'kg';
    });
    const item = items((await (await setup([withUnit])).call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect((item['physical'] as Json)['weight']).toEqual({ value: 8500, unit: 'kg' });
    expect(item['missing']).not.toContain('physical.weight.unit');
  });

  it('falls back ko → en → first for multi-language values; empty is null + missing (E-12)', async () => {
    const pkg = unitCopy(1, (env) => {
      const plate = submodel(env, 'DigitalNameplate');
      element(plate, 'ManufacturerProductDesignation')['value'] = [{ language: 'de', text: 'Linie DE' }, { language: 'en', text: 'Line EN' }];
      element(plate, 'ManufacturerProductFamily')['value'] = [{ language: 'de', text: 'Familie' }];
      element(plate, 'ManufacturerName')['value'] = [];
    });
    const { call } = await setup([pkg]);
    const ko = items((await call('GET', '/integrations/exports/equipment')).body)[0]!;
    const plate = ko['nameplate'] as Json;
    expect(plate['productDesignation']).toBe('Line EN');
    expect(plate['productFamily']).toBe('Familie');
    // An empty MLP in the nameplate: TechnicalData still names the manufacturer, and that value is used
    expect(plate['manufacturer']).toBe('Example Manufacturer Co., Ltd.');
    const de = items((await call('GET', '/integrations/exports/equipment', { query: { lang: 'de' } })).body)[0]!;
    expect((de['nameplate'] as Json)['productDesignation']).toBe('Linie DE');

    const empty = unitCopy(1, (env) => {
      element(submodel(env, 'DigitalNameplate'), 'ManufacturerProductFamily')['value'] = [];
    });
    const item = items((await (await setup([empty])).call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect((item['nameplate'] as Json)['productFamily']).toBeNull();
    expect(item['missing']).toContain('nameplate.productFamily');
  });

  it('reports a 41-character description for sap-pm without truncating it (E-14)', async () => {
    const long = 'A'.repeat(41);
    const pkg = unitCopy(1, (env) => {
      element(submodel(env, 'DigitalNameplate'), 'ManufacturerProductDesignation')['value'] = [{ language: 'ko', text: long }];
    });
    const { call } = await setup([pkg]);
    const sap = items((await call('GET', '/integrations/exports/equipment', { query: { profile: 'sap-pm' } })).body)[0]!;
    expect((sap['nameplate'] as Json)['productDesignation']).toBe(long);
    expect(sap['warnings']).toEqual([expect.stringContaining('41')]);
    const plain = items((await call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect(plain['warnings']).toEqual([]);
    expect((await call('GET', '/integrations/exports/equipment', { query: { profile: 'sap-xx' } })).status).toBe(400);
  });

  it('lists an Instance without a serial number in missing (INT-5)', async () => {
    const pkg = unitCopy(1, (env) => {
      element(submodel(env, 'DigitalNameplate'), 'SerialNumber')['value'] = '';
    });
    const item = items((await (await setup([pkg])).call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect((item['nameplate'] as Json)['serialNumber']).toBeNull();
    expect(item['missing']).toContain('nameplate.serialNumber');
  });

  it('traces every value to its AAS path with trace=1', async () => {
    const item = items((await (await setup()).call('GET', '/integrations/exports/equipment', { query: { trace: '1' } })).body)[0]!;
    expect((item['sourcePaths'] as Json)['nameplate.serialNumber']).toBe('DigitalNameplate/SerialNumber');
    expect((item['sourcePaths'] as Json)['physical.weight.value']).toBe('TechnicalData/TechnicalPropertyAreas[0]/GeneralEquipmentSpecification/DimensionSpec/TotalWeight');
  });

  it('places the unit by the company file: path and ISA-95 levels', async () => {
    const { call } = await setup([unitCopy(1), plantFile([{ name: 'RollForming_1', globalAssetId: unitAsset(1) }])]);
    const item = items((await call('GET', '/integrations/exports/equipment')).body)[0]!;
    expect(item['location']).toEqual({
      path: ['SampleFactory', 'PressLine', 'Forming', 'RollForming_1'],
      isa95: { site: null, area: 'PressLine', workCenter: 'Forming' },
    });
  });
});

describe('BOM', () => {
  it('matches the golden JSON and CSV and validates against its schema (E-1, E-3)', async () => {
    const { call, ids } = await setup();
    const asJson = await call('GET', '/integrations/exports/bom', { query: { packageId: ids[0]! } });
    expect(asJson.status).toBe(200);
    expect(checkSchema(EXPORT_SCHEMAS['vexplor.bom/1']! as JsonSchema, asJson.body)).toEqual([]);
    expectGolden('bom.json', `${JSON.stringify(normalized(asJson.body), null, 2)}\n`);
    const asCsv = await call('GET', '/integrations/exports/bom', { query: { packageId: ids[0]!, format: 'csv' } });
    expectGolden('bom.csv', text(asCsv.body));
    const rows = items(asJson.body);
    expect(rows.find((row) => row['childName'] === 'RollStandUnit')!['quantity']).toBe(12);
    expect(rows.every((row) => row['mapped'] === false)).toBe(true);
  });

  it('keeps rows keyed by globalAssetId when an entity is renamed or siblings are reordered (E-10)', async () => {
    const renamed = unitCopy(1, (env) => {
      element(submodel(env, 'HierarchicalStructures'), 'RollFormingMachine.Uncoiler')['idShort'] = 'Decoiler';
    });
    const reordered = unitCopy(1, (env) => {
      const entry = element(submodel(env, 'HierarchicalStructures'), 'RollFormingMachine');
      (entry['statements'] as Json[]).reverse();
    });
    const { call, ids } = await setup([unitCopy(1), renamed, reordered]);
    const bom = async (id: string) => items((await call('GET', '/integrations/exports/bom', { query: { packageId: id } })).body);
    const [base, afterRename, afterReorder] = [await bom(ids[0]!), await bom(ids[1]!), await bom(ids[2]!)];
    expect(afterReorder).toEqual(base);
    expect(afterRename.map((row) => row['childGlobalAssetId'])).toEqual(base.map((row) => row['childGlobalAssetId']));
    const uncoiler = afterRename.find((row) => row['childGlobalAssetId'] === 'https://www.smart-factory.kr/ids/asset/Uncoiler/1/0')!;
    expect(uncoiler['childName']).toBe('Decoiler');
  });

  it('refuses the Type fixture whose entry node points at another asset (INT-2, 422 naming both ids)', async () => {
    const { call, ids } = await setup([rollForming()]);
    const response = await call('GET', '/integrations/exports/bom', { query: { packageId: ids[0]! } });
    expect(response.status).toBe(422);
    const message = JSON.stringify(response.body);
    expect(message).toContain('BomRootMismatch');
    expect(message).toContain('RollFormingLine/1/0');
    expect(message).toContain('RollFormingMachine/1/0');
  });

  it('answers 400 without packageId and for an unknown format', async () => {
    const { call, ids } = await setup();
    expect((await call('GET', '/integrations/exports/bom')).status).toBe(400);
    expect((await call('GET', '/integrations/exports/bom', { query: { packageId: ids[0]!, format: 'xml' } })).status).toBe(400);
    expect((await call('GET', '/integrations/exports/bom', { query: { packageId: 'nope' } })).status).toBe(404);
  });
});

describe('Type link — typeAasId', () => {
  const OTHER_TYPE = 'https://www.smart-factory.kr/ids/aas/SomeOtherType/1/0';
  const derivedFrom = (aasId: string) => ({ type: 'ModelReference', keys: [{ type: 'AssetAdministrationShell', value: aasId }] });

  async function equipment(store: ReturnType<typeof createIntegrationStore>) {
    const response = await harness(store).call('GET', '/integrations/exports/equipment', { query: { includeTypes: '1' } });
    return items(response.body);
  }

  it('takes the shell\'s own derivedFrom when the server has no link (a unit read from a file)', async () => {
    const store = createIntegrationStore();
    const type = rollForming();
    const typeAasId = shellIdOf(type.environment);
    await store.importPackage({ name: 'type.aasx', package: type });
    await store.importPackage({ name: 'unit.aasx', package: unitCopy(1, (env) => { shell(env)['derivedFrom'] = derivedFrom(typeAasId); }) });
    const rows = await equipment(store);
    expect(rows.find((row) => row['assetKind'] === 'Instance')?.['typeAasId']).toBe(typeAasId);
    // A Type shell is not derived from a Type of its own
    expect(rows.find((row) => row['assetKind'] === 'Type')?.['typeAasId']).toBeNull();
  });

  it('keeps null without either link', async () => {
    const store = createIntegrationStore();
    await store.importPackage({ name: 'unit.aasx', package: unitCopy(1) });
    expect((await equipment(store))[0]?.['typeAasId']).toBeNull();
  });

  it('lets the server link win over derivedFrom', async () => {
    const store = createIntegrationStore();
    const type = rollForming();
    const typeRecord = await store.importPackage({ name: 'type.aasx', package: type });
    const link = derivationFile(newDerivation(typeRecord.id, 'type.aasx', type.environment));
    await store.importPackage({
      name: 'unit.aasx',
      package: unitCopy(1, (env) => { shell(env)['derivedFrom'] = derivedFrom(OTHER_TYPE); }),
      keep: [link],
    });
    const row = (await equipment(store)).find((candidate) => candidate['assetKind'] === 'Instance');
    expect(row?.['typeAasId']).toBe(shellIdOf(type.environment));
  });
});

function shellIdOf(environment: Parameters<typeof shell>[0]): string {
  return shell(environment)['id'] as string;
}
