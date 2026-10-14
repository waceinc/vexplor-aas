/**
 * Maintenance plan export — the CMMS job-plan shape (design §4.4; CMMS T14, INT-3; ERP E-9).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Environment } from '@aas/core';
import type { MaintenancePlan } from '../src/integration/exports/maintenance.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { element, expectGolden, harness, normalized, submodel, text, unitCopy, type Json } from './helpers/integration-fixtures.js';

async function setup(mutate?: (env: Environment) => void) {
  const store = createIntegrationStore();
  const pkg = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1, mutate) });
  const api = harness(store);
  const plans = async (): Promise<MaintenancePlan[]> =>
    ((await api.call('GET', '/integrations/exports/maintenance', { query: { packageId: pkg.id } })).body as { items: MaintenancePlan[] }).items;
  return { store, packageId: pkg.id, plans, ...api };
}

const steps = (env: Environment): Json[] =>
  element(submodel(env, 'MaintenanceInstructions'), 'MaintenanceInstructionsForSpecificInterval_0.ListMaintenanceSteps')['value'] as Json[];

describe('maintenance plan export', () => {
  it('matches the golden JSON and CSV (one row per step)', async () => {
    const { call, packageId } = await setup();
    const asJson = await call('GET', '/integrations/exports/maintenance', { query: { packageId } });
    expectGolden('maintenance.json', `${JSON.stringify(normalized(asJson.body), null, 2)}\n`);
    const asCsv = text((await call('GET', '/integrations/exports/maintenance', { query: { packageId, format: 'csv' } })).body);
    expectGolden('maintenance.csv', asCsv);
    expect(asCsv.trimEnd().split('\r\n')).toHaveLength(1 + 3);
  });

  it('never invents an interval, keeps step order, resolves tools and consumables, flags the signature (T14)', async () => {
    const [plan] = await (await setup()).plans();
    expect(plan!.maintenanceId).toBe('MI-RollForming-01');
    expect(plan!.interval).toBeNull();
    expect(plan!.intervalStatus).toBe('missing');
    expect(plan!.steps.map((step) => step.stepId)).toEqual(['RollStep01', 'RollStep02', 'RollStep03']);
    expect(plan!.steps.map((step) => [step.toolIds, step.consumableIds])).toEqual([
      [['TOOL-01'], []],
      [['TOOL-02'], ['CONS-01']],
      [[], []],
    ]);
    expect(plan!.steps.map((step) => step.signatureRequired)).toEqual([null, null, true]);
    expect(plan!.steps[0]!.duration).toEqual({ value: 15, unit: 'min' });
    expect(plan!.tools.map((tool) => tool.id)).toEqual(['TOOL-01', 'TOOL-02']);
    expect(plan!.consumables).toEqual([{ id: 'CONS-01', name: '교체용 성형 롤' }]);
    expect(plan!.unresolved).toEqual([]);
    expect(plan!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fills the interval only from an explicit value and unit', async () => {
    const [plan] = await (
      await setup((env) => {
        const holder = element(submodel(env, 'MaintenanceInstructions'), 'MaintenanceInstructionsForSpecificInterval_0');
        (holder['value'] as Json[]).push({
          idShort: 'MaintenanceInterval',
          modelType: 'SubmodelElementCollection',
          value: [
            { idShort: 'IntervalValue', modelType: 'Property', valueType: 'xs:double', value: '500' },
            { idShort: 'IntervalUnit', modelType: 'Property', valueType: 'xs:string', value: 'h' },
          ],
        });
      })
    ).plans();
    expect(plan!.interval).toEqual({ value: 500, unit: 'h', basis: null });
    expect(plan!.intervalStatus).toBe('present');

    // A value without a unit is not an interval
    const [noUnit] = await (
      await setup((env) => {
        const holder = element(submodel(env, 'MaintenanceInstructions'), 'MaintenanceInstructionsForSpecificInterval_0');
        (holder['value'] as Json[]).push({ idShort: 'MaintenanceInterval', modelType: 'Property', valueType: 'xs:double', value: '500' });
      })
    ).plans();
    expect(noUnit!.intervalStatus).toBe('missing');
    const [collectionWithoutUnit] = await (
      await setup((env) => {
        const holder = element(submodel(env, 'MaintenanceInstructions'), 'MaintenanceInstructionsForSpecificInterval_0');
        (holder['value'] as Json[]).push({
          idShort: 'MaintenanceInterval',
          modelType: 'SubmodelElementCollection',
          value: [{ idShort: 'IntervalValue', modelType: 'Property', valueType: 'xs:double', value: '500' }],
        });
      })
    ).plans();
    expect(collectionWithoutUnit!.interval).toBeNull();
    expect(collectionWithoutUnit!.intervalStatus).toBe('missing');
  });

  it('reports a reference it cannot follow instead of dropping it', async () => {
    const [plan] = await (
      await setup((env) => {
        const ref = element(steps(env)[0]!, 'ToolsForMaintenanceStep');
        ((ref['value'] as Json)['keys'] as Json[])[2]!['value'] = 'NoSuchTool';
      })
    ).plans();
    expect(plan!.steps[0]!.toolIds).toEqual([]);
    expect(plan!.unresolved).toEqual([expect.stringContaining('NoSuchTool')]);
  });

  it('keeps steps and tools keyed by business keys when the tool list is reordered (E-9)', async () => {
    // References by idShort follow the item, wherever it moves
    const byIdShort = (env: Environment): void => {
      for (const step of steps(env)) {
        for (const item of step['value'] as Json[]) {
          if (item['modelType'] !== 'ReferenceElement') continue;
          const last = ((item['value'] as Json)['keys'] as Json[])[2]!;
          last['value'] = String(last['value']).replace('MaintenanceTool_', 'MaintenanceToolListEntry_').replace('MaintenanceConsumable_', 'MaintenanceConsumablesListEntry_');
        }
      }
    };
    const before = await (await setup(byIdShort)).plans();
    const after = await (
      await setup((env) => {
        byIdShort(env);
        (element(submodel(env, 'MaintenanceInstructions'), 'MaintenanceToolList')['value'] as Json[]).reverse();
      })
    ).plans();
    expect(after).toEqual(before);
  });

  it('changes the content hash when a step changes, and only then', async () => {
    const first = (await (await setup()).plans())[0]!.contentHash;
    const again = (await (await setup()).plans())[0]!.contentHash;
    const changed = (
      await (
        await setup((env) => {
          element(steps(env)[0]!, 'EstimatedDurationTimeMaintenanceStep.ValueEstimatedDurationTimeMaintenanceStep')['value'] = '20.0';
        })
      ).plans()
    )[0]!.contentHash;
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('links a step document: missing part → available false, stored part → URL and sha256', async () => {
    const { store, packageId, plans } = await setup();
    expect((await plans())[0]!.steps[2]!.documents).toEqual([
      { fileName: 'file:///RollReplace_Record_V1.pdf', contentType: 'application/pdf', size: null, sha256: null, available: false, url: null },
    ]);
    await store.putPackageFile(packageId, { part: '/RollReplace_Record_V1.pdf', role: 'supplementary', contentType: 'application/pdf', data: new TextEncoder().encode('%PDF-record') });
    const linked = (await plans())[0]!.steps[2]!.documents[0]!;
    expect(linked.available).toBe(true);
    expect(linked.url).toMatch(/\/submodel-elements\/MaintenanceInstructionsForSpecificInterval_0\.ListMaintenanceSteps\.MaintenanceStep_3\.RelatedDocumentOrFileMaintenanceStep\/attachment$/);
    expect(linked.sha256).toBe(createHash('sha256').update('%PDF-record').digest('hex'));
    expect(linked.size).toBe(11);
  });
});
