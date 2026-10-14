/**
 * Integration readiness checks INT-1…INT-5 (design §8; ERP E-7, E-8; CMMS T13).
 */
import { describe, expect, it } from 'vitest';
import { readinessChecks } from '../src/integration/exports/readiness.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { element, expectGolden, harness, plantFile, rollForming, submodel, unitAsset, unitCopy, type Json } from './helpers/integration-fixtures.js';

const ids = (env: Parameters<typeof readinessChecks>[0]): string[] => readinessChecks(env).map((check) => check.id);

describe('readiness checks', () => {
  it('flag the Type sample with INT-1 (serial on a Type) and INT-2 (BOM root ≠ shell asset), golden', async () => {
    const store = createIntegrationStore();
    const pkg = await store.importPackage({ name: 'sample.aasx', package: rollForming() });
    const response = await harness(store).call('GET', '/integrations/readiness', { query: { packageId: pkg.id } });
    expect(response.status).toBe(200);
    const checks = ((response.body as { items: { checks: Json[] }[] }).items[0]!).checks;
    expect(checks.map((check) => check['id'])).toEqual(['INT-1', 'INT-2', 'INT-3']);
    expect(checks.find((check) => check['id'] === 'INT-2')!['severity']).toBe('error');
    expect(String(checks.find((check) => check['id'] === 'INT-2')!['message'])).toContain('RollFormingLine/1/0');
    expectGolden('readiness.json', `${JSON.stringify(response.body, null, 2)}\n`);
  });

  it('leave the per-unit Instance with only the missing interval (INT-3)', () => {
    expect(ids(unitCopy(1).environment)).toEqual(['INT-3']);
  });

  it('report an Instance without a serial number (INT-5)', () => {
    const { environment } = unitCopy(1, (env) => {
      element(submodel(env, 'DigitalNameplate'), 'SerialNumber')['value'] = '';
    });
    expect(ids(environment)).toEqual(['INT-5', 'INT-3']);
  });

  it('report ×n on equipment in a process file (INT-4), but not a quantity inside an equipment BOM', () => {
    const plant = plantFile([{ name: 'RollForming_1', globalAssetId: unitAsset(1), bulkCount: 2 }]).environment;
    const checks = readinessChecks(plant);
    expect(checks).toEqual([expect.objectContaining({ id: 'INT-4', severity: 'warning', pointer: 'SampleFactory/PressLine/Forming/RollForming_1' })]);
    // The unit's own BOM has RollStandUnit ×12 — a part quantity, not n machines
    expect(ids(unitCopy(1).environment)).not.toContain('INT-4');
  });

  it('list every visible package when no packageId is given', async () => {
    const store = createIntegrationStore();
    await store.importPackage({ name: 'a.aasx', package: unitCopy(1) });
    await store.importPackage({ name: 'b.aasx', package: rollForming() });
    const body = (await harness(store).call('GET', '/integrations/readiness')).body as { items: { packageId: string }[] };
    expect(body.items.map((item) => item.packageId)).toEqual(['pkg_1', 'pkg_2']);
  });
});
