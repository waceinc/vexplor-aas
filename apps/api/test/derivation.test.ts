/**
 * Type -> unit propagation API — files created by splitting per unit receive changes from the type file (routes/derivation.ts).
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore, type AasStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAttachments } from '../src/routes/bundle-files.js';
import { DERIVATION_PART } from '../src/routes/derivation.js';

type Json = Record<string, unknown>;
interface Change {
  key: string;
  path: string;
  kind: string;
  action: string;
  reason?: string;
}
interface Plan {
  linked: boolean;
  sourceName?: string;
  sourceMissing?: boolean;
  changes: Change[];
  counts?: { apply: number; skip: number };
}

const fixtureBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

function harness(store: AasStore = new InMemoryStore()) {
  const handle = createApi(store);
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const response = await handle({
      method,
      path,
      query: {},
      queryAll: {},
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body } : {}),
    } as ApiRequest);
    return { status: response.status, body: response.body };
  };
  return { store, call };
}

/** Edits one element of a submodel — uses the store directly (the same path as a human edit: updateIdentifiable) */
async function setValue(store: AasStore, packageId: string, submodelIdShort: string, idShort: string, value: string): Promise<void> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === submodelIdShort)!;
  const element = (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!;
  element['value'] = value;
  await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), submodel);
}

async function valueOf(store: AasStore, packageId: string, submodelIdShort: string, idShort: string): Promise<unknown> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === submodelIdShort)!;
  return (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!['value'];
}

async function setup() {
  const h = harness();
  const type = await h.store.importPackage({ name: '롤포밍기.aasx', package: readAasx(fixtureBytes) });
  const made = await h.call('POST', `/packages/${type.id}/clone`, { assetName: 'RollFormingMachine_1' });
  expect(made.status).toBe(201);
  const instanceId = String((made.body as Json)['packageId']);
  return { ...h, typeId: type.id, instanceId };
}

describe('type -> unit propagation API', () => {
  it('splitting per unit links to the type, and right after there is nothing to propagate — revision stays 1', async () => {
    const { call, store, instanceId } = await setup();
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(plan.linked).toBe(true);
    expect(plan.sourceName).toBe('롤포밍기.aasx');
    expect(plan.counts?.apply).toBe(0);
    expect((await store.getPackage(instanceId))!.revision).toBe(1);
  });

  it('editing the type creates propagation targets and skips field-edited values — propagating brings down only type values and leaves field values', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, instanceId, 'DigitalNameplate', 'SerialNumber', 'SN-0001'); // field edit
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027'); // type edit
    await setValue(store, typeId, 'DigitalNameplate', 'SerialNumber', 'SN-TYPE'); // type also edited — the field value wins

    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    const byPath = new Map(plan.changes.map((c) => [c.path, c]));
    expect(byPath.get('YearOfConstruction')).toMatchObject({ kind: 'changed', action: 'apply' });
    expect(byPath.get('SerialNumber')).toMatchObject({ kind: 'changed', action: 'skip', reason: 'edited-here' });

    const applied = await call('POST', `/packages/${instanceId}/derivation/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: 1, submodels: 1, skipped: 1 });
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe('2027');
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'SerialNumber')).toBe('SN-0001');

    // After propagating, it is no longer shown
    const after = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(after.counts?.apply).toBe(0);
  });

  it('propagates only the selected rows — unselected rows remain for next time', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    await setValue(store, typeId, 'DigitalNameplate', 'ManufacturerProductType', 'RF-NEXT');
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    const year = plan.changes.find((c) => c.path === 'YearOfConstruction')!;
    await call('POST', `/packages/${instanceId}/derivation/apply`, { keys: [year.key] });
    const left = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(left.changes.filter((c) => c.action === 'apply').map((c) => c.path)).toEqual(['ManufacturerProductType']);
  });

  it('propagation can be undone — it stays in the "Undo" list as "Apply type changes"', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    const before = await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction');
    await call('POST', `/packages/${instanceId}/derivation/apply`, {});
    const status = (await call('GET', `/packages/${instanceId}/undo`)).body as { undo: string[] };
    expect(status.undo[0]).toBe('형식 변경 반영');
    await call('POST', `/packages/${instanceId}/undo`);
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe(before);
    // The type copy (baseline) must roll back too so the same change shows up again as "apply" — rolling back only the value made it wrongly appear as "value edited on this unit"
    const again = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(again.changes.map((c) => [c.path, c.action])).toEqual([['YearOfConstruction', 'apply']]);
    // Redo moves the value and the baseline forward together
    await call('POST', `/packages/${instanceId}/redo`);
    expect(await valueOf(store, instanceId, 'DigitalNameplate', 'YearOfConstruction')).toBe('2027');
    expect(((await call('GET', `/packages/${instanceId}/derivation`)).body as Plan).counts?.apply).toBe(0);
  });

  it('undoing another edit leaves the type link intact — the side file moves only when undoing a propagation', async () => {
    const { call, store, typeId } = await setup();
    const older = await store.importPackage({ name: '옛호기.aasx', package: readAasx(fixtureBytes) });
    const environment = await store.getEnvironment(older.id);
    const nameplate = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === 'DigitalNameplate')!;
    const patched = await call('PATCH', `/packages/${older.id}/api/v3.0/submodels/${Buffer.from(String(nameplate['id'])).toString('base64url')}/submodel-elements/SerialNumber/$value`, 'SN-9');
    expect(patched.status).toBe(204);
    await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: typeId });
    await call('POST', `/packages/${older.id}/undo`);
    expect(await valueOf(store, older.id, 'DigitalNameplate', 'SerialNumber')).not.toBe('SN-9');
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(true);
  });

  it('the type copy is not exported to AASX and does not mix into the bundle attachment list', async () => {
    const { store, instanceId } = await setup();
    expect((await store.packageFiles(instanceId)).some((f) => f.part === DERIVATION_PART)).toBe(true);
    const exported = await store.exportPackage(instanceId);
    const parts = [...exported.extraParts.keys(), ...exported.supplementaryFiles.map((f) => f.part)];
    expect(parts.some((part) => part.includes('.derivation'))).toBe(false);
    expect(await listAttachments(store, instanceId)).toEqual([]);
  });

  it('the uploaded original (/.original/) does not mix into the bundle attachment list either', async () => {
    const { call, store } = harness();
    const uploaded = await call('POST', '/packages', undefined);
    expect(uploaded.status).toBeGreaterThanOrEqual(400); // an upload without a body is rejected — below goes straight to the store
    const record = await store.importPackage({
      name: 'a.aasx',
      package: readAasx(fixtureBytes),
      keep: [{ part: '/.original/source.aasx', role: 'bundle', contentType: 'application/octet-stream', data: fixtureBytes }],
    });
    expect(await listAttachments(store, record.id)).toEqual([]);
  });

  it('units created before this feature can be linked too — the baseline is the type at link time; unlinking removes the link', async () => {
    const { call, store, typeId } = await setup();
    const older = await store.importPackage({ name: '옛호기.aasx', package: readAasx(fixtureBytes) });
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(false);
    expect((await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: older.id })).status).toBe(400);
    expect((await call('PUT', `/packages/${older.id}/derivation`, { sourcePackageId: typeId })).status).toBe(200);
    await setValue(store, typeId, 'DigitalNameplate', 'YearOfConstruction', '2027');
    const plan = (await call('GET', `/packages/${older.id}/derivation`)).body as Plan;
    expect(plan.changes.map((c) => [c.path, c.action])).toEqual([['YearOfConstruction', 'apply']]);
    expect((await call('DELETE', `/packages/${older.id}/derivation`)).status).toBe(204);
    expect(((await call('GET', `/packages/${older.id}/derivation`)).body as Plan).linked).toBe(false);
  });

  it('when the type file is deleted, says so and rejects propagation', async () => {
    const { call, store, typeId, instanceId } = await setup();
    await store.deletePackage(typeId);
    const plan = (await call('GET', `/packages/${instanceId}/derivation`)).body as Plan;
    expect(plan).toMatchObject({ linked: true, sourceMissing: true, changes: [] });
    expect((await call('POST', `/packages/${instanceId}/derivation/apply`, {})).status).toBe(409);
  });
});
