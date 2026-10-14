/**
 * Projection scenario for the schema test (moved out of integration-projector.test.ts, so importing it does not also
 * import that file's tests): the projection events of a created → edited → deleted unit.
 */
import type { StoredEvent } from '@aas/store';
import { IntegrationProjector } from '../../src/integration/projector.js';
import { createIntegrationStore, type IntegrationTestStore } from './integration-store.js';
import { element, submodel, unitCopy } from './integration-fixtures.js';

function clock(start = Date.parse('2026-10-14T00:00:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

export async function editSerial(store: IntegrationTestStore, packageId: string, serial: string): Promise<void> {
  const env = await store.getEnvironment(packageId);
  const plate = submodel(env, 'DigitalNameplate');
  element(plate, 'SerialNumber')['value'] = serial;
  await store.updateIdentifiable(packageId, 'Submodel', String(plate['id']), plate);
}

export async function projectionScenario(): Promise<StoredEvent[]> {
  const store = createIntegrationStore();
  const time = clock();
  const projector = new IntegrationProjector({ store, now: time.now });
  await projector.runOnce();
  const pkg = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1) });
  const created = await projector.flushNow();
  await editSerial(store, pkg.id, 'SN-NEW');
  const updated = await projector.flushNow();
  await store.deletePackage(pkg.id);
  const removed = await projector.flushNow();
  return [...created, ...updated, ...removed];
}
