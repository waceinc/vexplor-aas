/**
 * Projection events (design §2.3, §13.4; ERP E-19, E-20, E-22): debounce, digests, deterministic ids, removal.
 * The schema test validates the events of `projectionScenario()` (helpers/integration-projection.ts).
 */
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '@aas/store';
import { createJoinResolver } from '../src/integration/exports/join.js';
import { IntegrationProjector, PROJECTOR_CURSOR_KEY } from '../src/integration/projector.js';
import { createIntegrationStore, type IntegrationTestStore } from './helpers/integration-store.js';
import { element, plantFile, shell, submodel, unitAsset, unitCopy, type Json } from './helpers/integration-fixtures.js';
import { editSerial } from './helpers/integration-projection.js';

const MASTER = 'kr.vexplor.aas.equipment.master.changed.v1';

function clock(start = Date.parse('2026-10-14T00:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** A store with one unit, and a projector that has already taken its silent baseline */
async function setup() {
  const store = createIntegrationStore();
  const time = clock();
  const pkg = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1) });
  const projector = new IntegrationProjector({ store, now: time.now });
  expect(await projector.runOnce()).toEqual([]);
  return { store, time, projector, packageId: pkg.id };
}

const types = (events: readonly StoredEvent[]): string[] => events.map((event) => event.type);

/** The debounce runs from when the projector sees a change: poll once, then let the window pass */
async function settle(projector: IntegrationProjector, time: ReturnType<typeof clock>): Promise<StoredEvent[]> {
  expect(await projector.runOnce()).toEqual([]);
  time.advance(5_000);
  return projector.runOnce();
}


describe('IntegrationProjector', () => {
  it('emits exactly one master event with changedKeys after the 5 s debounce (E-19)', async () => {
    const { store, time, projector, packageId } = await setup();
    await editSerial(store, packageId, 'EXM-RFL-2026-00999');
    time.advance(3_000);
    await editSerial(store, packageId, 'EXM-RFL-2026-01000');
    expect(await projector.runOnce()).toEqual([]);
    time.advance(4_999);
    expect(await projector.runOnce()).toEqual([]);
    time.advance(1);
    const events = await projector.runOnce();
    expect(types(events)).toEqual([MASTER]);
    const data = events[0]!.data as Json;
    expect(data['operation']).toBe('updated');
    expect(data['changedKeys']).toEqual(['nameplate.serialNumber']);
    expect((data['asset'] as Json)['serialNumber']).toBe('EXM-RFL-2026-01000');
    expect(data['href']).toBe(`/integrations/exports/equipment?format=json&packageId=${packageId}`);
    expect(events[0]!.subject).toBe(unitAsset(1));
    expect(await projector.runOnce()).toEqual([]);
  });

  it('stays silent for live values, a thumbnail and operational data (E-20)', async () => {
    const { store, time, projector, packageId } = await setup();
    await store.appendValues(packageId, [{ packageId, interfaceName: 'PLC1', propertyName: 'MachineState', observedAt: new Date().toISOString(), valueText: 'run' }]);
    await store.putPackageFile(packageId, { part: '/thumbnail.png', role: 'thumbnail', contentType: 'image/png', data: new Uint8Array([1, 2, 3]) });
    const env = await store.getEnvironment(packageId);
    const operational = submodel(env, 'OperationalData');
    operational['description'] = [{ language: 'en', text: 'edited' }];
    await store.updateIdentifiable(packageId, 'Submodel', String(operational['id']), operational);
    expect(await settle(projector, time)).toEqual([]);
    // The changes were seen and projected — just found equal
    expect(await store.getRuntimeState(PROJECTOR_CURSOR_KEY)).toEqual({ seq: (await store.readEvents({ after: 0, limit: 1 })).lastSeq });
  });

  it('announces a new unit as created and a deleted one as removed (E-22)', async () => {
    const { store, time, projector } = await setup();
    const added = await store.importPackage({ name: 'unit-2.aasx', package: unitCopy(2) });
    const created = await settle(projector, time);
    expect(types(created).sort()).toEqual([
      'kr.vexplor.aas.equipment.bom.changed.v1',
      'kr.vexplor.aas.equipment.documents.changed.v1',
      'kr.vexplor.aas.equipment.maintenance.changed.v1',
      MASTER,
    ]);
    expect(created.every((event) => (event.data as Json)['operation'] === 'created')).toBe(true);

    await store.deletePackage(added.id);
    const removed = await settle(projector, time);
    const master = removed.find((event) => event.type === MASTER)!;
    expect((master.data as Json)['operation']).toBe('removed');
    expect(((master.data as Json)['asset'] as Json)['globalAssetId']).toBe(unitAsset(2));
    expect(removed.every((event) => (event.data as Json)['operation'] === 'removed')).toBe(true);
    expect(removed).toHaveLength(4);
  });

  it('does not lose an edit that lands while a pass is appending, even with a flushNow in between (M2)', async () => {
    const { store, time, projector, packageId } = await setup();
    const other = await store.importPackage({ name: 'unit-2.aasx', package: unitCopy(2) });
    await editSerial(store, packageId, 'SN-1');
    await projector.runOnce();
    time.advance(5_000);
    // Hold the first append of the next pass
    const realAppend = store.appendEvents.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let held = false;
    (store as unknown as { appendEvents: typeof realAppend }).appendEvents = async (events) => {
      // Hold the append of this package's SN-1 event, wherever it falls in the pass
      if (!held && events.some((event) => event.packageId === packageId)) {
        held = true;
        entered();
        await new Promise<void>((resolve) => (release = resolve));
      }
      return realAppend(events);
    };
    const pass = projector.runOnce();
    await inside;
    await editSerial(store, packageId, 'SN-2');
    const flush = projector.flushNow(other.id);
    release();
    await Promise.all([pass, flush]);
    for (let i = 0; i < 3; i += 1) {
      time.advance(60_000);
      await projector.runOnce();
    }
    const serials = (await store.readEvents({ after: 0, limit: 1000, types: [MASTER] })).items
      .filter((event) => event.packageId === packageId)
      .map((event) => ((event.data as Json)['asset'] as Json)['serialNumber']);
    expect(serials).toEqual(['SN-1', 'SN-2']);
  });

  it('removes the digest row once the removal events are out (L8)', async () => {
    const { store, time, projector, packageId } = await setup();
    expect(await store.getRuntimeState(`projector:${packageId}`)).toBeTruthy();
    await store.deletePackage(packageId);
    const removed = await settle(projector, time);
    expect(removed.length).toBeGreaterThan(0);
    expect(await store.getRuntimeState(`projector:${packageId}`)).toBeUndefined();
  });

  it('keeps the digest when the removal append fails, so a retry still announces it (L8)', async () => {
    const { store, time, projector, packageId } = await setup();
    await store.deletePackage(packageId);
    expect(await projector.runOnce()).toEqual([]);
    time.advance(5_000);
    const realAppend = store.appendEvents.bind(store);
    (store as unknown as { appendEvents: unknown }).appendEvents = async () => {
      throw new Error('disk full');
    };
    await expect(projector.runOnce()).rejects.toThrow('disk full');
    expect(await store.getRuntimeState(`projector:${packageId}`)).toBeTruthy();
    (store as unknown as { appendEvents: typeof realAppend }).appendEvents = realAppend;
    const retried = await projector.runOnce();
    expect(retried.some((event) => (event.data as Json)['operation'] === 'removed')).toBe(true);
  });

  it('re-projects after a crash with the same ids, so nothing is announced twice', async () => {
    const { store, time, projector, packageId } = await setup();
    const cursor = await store.getRuntimeState(PROJECTOR_CURSOR_KEY);
    const digest = await store.getRuntimeState(`projector:${packageId}`);
    await editSerial(store, packageId, 'SN-CRASH');
    const first = await settle(projector, time);
    expect(first).toHaveLength(1);
    // Crash after the append, before the digest and cursor were saved
    await store.putRuntimeState(PROJECTOR_CURSOR_KEY, cursor);
    await store.putRuntimeState(`projector:${packageId}`, digest);
    const restarted = new IntegrationProjector({ store, now: time.now });
    expect(await settle(restarted, time)).toEqual([]);
    const all = (await store.readEvents({ after: 0, limit: 1000 })).items.filter((event) => event.type === MASTER);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(first[0]!.id);
  });

  it('projects an external-refs change on flushNow(packageId) with changedKeys externalRefs', async () => {
    const { store, projector, packageId } = await setup();
    await store.putExternalRefs(packageId, {
      schema: 'vexplor.externalRefs/1',
      subjects: [{ subject: { kind: 'asset', globalAssetId: unitAsset(1) }, refs: [{ system: 'icube:WACE', type: 'equipmentCode', id: 'EQ-0127' }, { system: 'icube:WACE', type: 'costCenter', id: 'CC-1' }] }],
    });
    const events = await projector.flushNow(packageId);
    expect(types(events)).toEqual([MASTER]);
    const data = events[0]!.data as Json;
    expect(data['changedKeys']).toEqual(['externalRefs']);
    // The join block carries public refs only
    expect((data['asset'] as Json)['externalRefs']).toEqual([{ system: 'icube:WACE', type: 'equipmentCode', id: 'EQ-0127' }]);
  });

  it('re-projects the equipment a company file places when that file changes', async () => {
    const { store, time, projector, packageId } = await setup();
    const plant = await store.importPackage({ name: 'plant.aasx', package: plantFile([{ name: 'RollForming_1', globalAssetId: unitAsset(1) }]) });
    // The plant file has no equipment row and no BOM of its own; the unit's location changed with it
    const placed = await settle(projector, time);
    expect(types(placed)).toEqual([MASTER]);
    expect(placed[0]!.packageId).toBe(packageId);
    expect((placed[0]!.data as Json)['changedKeys']).toEqual(['location.isa95.area', 'location.isa95.workCenter', 'location.path']);
    expect(((placed[0]!.data as Json)['asset'] as Json)['path']).toEqual(['SampleFactory', 'PressLine', 'Forming', 'RollForming_1']);

    // Removing the company file takes the location away again
    await store.deletePackage(plant.id);
    const unplaced = await settle(projector, time);
    expect(types(unplaced)).toEqual([MASTER]);
    expect(((unplaced[0]!.data as Json)['asset'] as Json)['path']).toEqual([]);
  });
});

describe('createJoinResolver', () => {
  it('builds the asset block and serves it from cache until invalidated', async () => {
    const store = createIntegrationStore();
    const pkg = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1) });
    const join = createJoinResolver(store);
    const first = await join(pkg.id);
    expect(first).toMatchObject({ globalAssetId: unitAsset(1), assetKind: 'Instance', serialNumber: 'EXM-RFL-2026-00127', path: [], isa95: null });
    await editSerial(store, pkg.id, 'SN-2');
    expect((await join(pkg.id))!.serialNumber).toBe('EXM-RFL-2026-00127');
    join.invalidate(pkg.id);
    expect((await join(pkg.id))!.serialNumber).toBe('SN-2');
    expect(await join('missing')).toBeNull();
  });

  it('marks an asset placed by two company files as ambiguous and takes the lowest package id', async () => {
    const store = createIntegrationStore();
    const unit = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1) });
    await store.importPackage({ name: 'plant-a.aasx', package: plantFile([{ name: 'First', globalAssetId: unitAsset(1) }]) });
    await store.importPackage({ name: 'plant-b.aasx', package: plantFile([{ name: 'Second', globalAssetId: unitAsset(1) }]) });
    const block = await createJoinResolver(store)(unit.id);
    expect(block!.path).toEqual(['SampleFactory', 'PressLine', 'Forming', 'First']);
    expect(block!.pathAmbiguous).toBe(true);
    expect(shell(await store.getEnvironment(unit.id))['id']).toBe(block!.aasId);
  });
});
