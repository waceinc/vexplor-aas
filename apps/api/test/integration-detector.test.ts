/**
 * Equipment detector (docs/design/integration-v1.md §6.3, test plan rows "MES B" and CMMS T8–T12, T17).
 *
 * Every test drives the detector with the cycles the supervisor would hand it and reads the events back from the store,
 * so what is asserted is what a receiver would get — including the dedupe of a re-processed cycle.
 */
import { defaultServerIntegrationConfig, EVENT_TYPES, type PackageIntegrationConfig } from '@aas/core';
import type { StoredEvent } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { detectorStateKey } from '../src/integration/runtime/detector.js';
import { CycleClock, detectorFor, environmentWith, iface, runtimeEventScenario, runtimeStore, seededPackage, type RuntimeStore, type SampleValue } from './helpers/integration-runtime.js';

const PROPS = ['MachineState', 'AlarmActive', 'AlarmCode', 'MotorTemperature', 'ProductionCount', 'MaintenanceMode'];

async function setup(config: Partial<PackageIntegrationConfig> | null, options: { base?: string; globalAssetId?: string | null; interfaces?: string[] } = {}) {
  const store = await runtimeStore();
  const record = await seededPackage(store);
  if (config) await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1', ...config });
  const interfaces = (options.interfaces ?? ['PLC1']).map((name, index) => iface(name, index === 0 ? PROPS : [], options.base));
  const clock = new CycleClock(record, environmentWith(PROPS), interfaces);
  const detector = detectorFor(store, undefined, options.globalAssetId);
  const run = async (values: Record<string, SampleValue>, failed: string[] = []): Promise<StoredEvent[]> => detector.onPackageCycle(clock.cycle(values, failed));
  return { store, record, clock, detector, run };
}

/** Runtime events only — seeding a package also records model events (package created), which are not the detector's */
async function allEvents(store: RuntimeStore): Promise<StoredEvent[]> {
  return (await store.readEvents({ after: 0, limit: 1000 })).items.filter((event) => !event.type.startsWith('kr.vexplor.aas.model.'));
}

const ofType = (events: readonly StoredEvent[], type: string): StoredEvent[] => events.filter((event) => event.type === type);

const STATE = { state: { property: 'MachineState', interfaceName: null, rules: null } };

describe('state changes', () => {
  it('run → alarm → run is two events; a constant value none; the first observation none', async () => {
    const { store, run } = await setup(STATE);
    for (const value of ['run', 'run', 'alarm', 'alarm', 'run', 'run']) await run({ MachineState: value });
    const events = ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged);
    expect(events.map((event) => [event.data['previousState'], event.data['state']])).toEqual([
      ['run', 'alarm'],
      ['alarm', 'run'],
    ]);
    const first = events[0]!;
    expect(first.data).toMatchObject({ previousStateSince: '2026-10-14T00:00:00.000Z', previousDurationMs: 2000, rawValue: 'alarm', detectionResolutionMs: 1000, suppressed: false });
    expect(first.data['ruleSetHash']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.time).toBe('2026-10-14T00:00:02.000Z');
    expect(first.subject).toBe('https://example.com/ids/asset/press-03');
    expect(first.id).toMatch(/^evt_[0-9A-Z]{26}$/);
  });

  it('a value outside the rules is unknown — never stop', async () => {
    const { store, run } = await setup(STATE);
    await run({ MachineState: 'run' });
    await run({ MachineState: 'Mode 7' });
    const [event] = ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged);
    expect(event!.data).toMatchObject({ state: 'unknown', previousState: 'run' });
  });

  it('bad-quality samples are ignored for the state', async () => {
    const { store, run } = await setup(STATE);
    await run({ MachineState: 'run' });
    await run({ MachineState: { value: 'stop', quality: 'BadDeviceFailure' } });
    await run({ MachineState: 'run' });
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged)).toEqual([]);
  });

  it('a restart (new detector, same store) does not announce the current state again', async () => {
    const { store, record, clock, run } = await setup(STATE);
    await run({ MachineState: 'run' });
    await run({ MachineState: 'stop' });
    const restarted = detectorFor(store);
    expect(await restarted.onPackageCycle(clock.cycle({ MachineState: 'stop' }))).toEqual([]);
    const changed = await restarted.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    expect(changed.map((event) => event.data['state'])).toEqual(['run']);
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged)).toHaveLength(2);
    expect(record.id).toBeTruthy();
  });

  it('a cycle processed again after a crash (events stored, state not) produces the same ids and nothing new', async () => {
    const { store, record, clock, detector } = await setup(STATE);
    await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    const before = await store.getRuntimeState(detectorStateKey(record.id));
    const cycle = clock.cycle({ MachineState: 'stop' });
    const first = await detector.onPackageCycle(cycle);
    expect(first).toHaveLength(1);
    // Simulate the crash window: the state write never happened
    await store.putRuntimeState(detectorStateKey(record.id), before, record.id);
    const again = await detectorFor(store).onPackageCycle(cycle);
    expect(again).toEqual([]);
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged)).toHaveLength(1);
  });

  it('a rule change re-labels silently; the next real change carries the new hash', async () => {
    const store = await runtimeStore();
    const record = await seededPackage(store);
    await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1', ...STATE });
    const clock = new CycleClock(record, environmentWith(PROPS), [iface('PLC1', PROPS)]);
    const before = detectorFor(store);
    await before.onPackageCycle(clock.cycle({ MachineState: 'Mode 7' })); // unknown under the default rules
    const server = defaultServerIntegrationConfig('9f2c4e1a7b3d');
    server.stateRules = { ...server.stateRules, run: [...server.stateRules.run, 'Mode 7'] };
    const after = detectorFor(store, server);
    expect(await after.onPackageCycle(clock.cycle({ MachineState: 'Mode 7' }))).toEqual([]);
    const [event] = await after.onPackageCycle(clock.cycle({ MachineState: 'stop' }));
    expect(event!.data).toMatchObject({ previousState: 'run', state: 'stop' });
    const firstHash = (await store.getRuntimeState(detectorStateKey(record.id))) as { ruleSetHash: string };
    expect(event!.data['ruleSetHash']).toBe(firstHash.ruleSetHash);
  });

  it('a rule change while no state sample arrives keeps the old hash, so the later re-label is still silent', async () => {
    const store = await runtimeStore();
    const record = await seededPackage(store);
    await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1', ...STATE });
    const clock = new CycleClock(record, environmentWith(PROPS), [iface('PLC1', PROPS)]);
    await detectorFor(store).onPackageCycle(clock.cycle({ MachineState: 'Mode 7' }));
    const server = defaultServerIntegrationConfig('9f2c4e1a7b3d');
    server.stateRules = { ...server.stateRules, run: [...server.stateRules.run, 'Mode 7'] };
    const after = detectorFor(store, server);
    expect(await after.onPackageCycle(clock.cycle({}))).toEqual([]);
    expect(await after.onPackageCycle(clock.cycle({ MachineState: 'Mode 7' }))).toEqual([]);
  });
});

describe('alarms', () => {
  it('golden: 10 minutes at 1 s with a 5 s alarm every 40 s → 15 raised, 15 cleared, pairs share the instance id, 5 s each', async () => {
    const { store, run } = await setup({
      ...STATE,
      alarms: [{ id: 'alarm-main', property: 'AlarmActive', activeWhen: 'truthy', codeProperty: 'AlarmCode', textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: ['MI-1'] }],
    });
    for (let t = 0; t < 600; t++) {
      const active = t % 40 >= 10 && t % 40 < 15;
      await run({ MachineState: active ? 'alarm' : 'run', AlarmActive: active ? 1 : 0, AlarmCode: active ? 'E-217' : '' });
    }
    const events = await allEvents(store);
    const raised = ofType(events, EVENT_TYPES.equipmentAlarmRaised);
    const cleared = ofType(events, EVENT_TYPES.equipmentAlarmCleared);
    expect(raised).toHaveLength(15);
    expect(cleared).toHaveLength(15);
    raised.forEach((event, index) => {
      expect(cleared[index]!.data['alarmInstanceId']).toBe(event.data['alarmInstanceId']);
      expect(event.data['alarmInstanceId']).toMatch(/^alm_[0-9A-Z]{26}$/);
      const duration = cleared[index]!.data['durationMs'] as number;
      expect(Math.abs(duration - 5000)).toBeLessThanOrEqual(1000);
      expect(event.data).toMatchObject({ code: 'E-217', occurrences: 1, clearedAt: null, maintenanceIds: ['MI-1'] });
      expect(cleared[index]!.data).toMatchObject({ code: 'E-217', clearedAt: expect.any(String) });
    });
    expect(new Set(raised.map((event) => event.data['alarmInstanceId'])).size).toBe(15);
    // A state of alarm gives state events only — alarm events come from the alarm rule, never twice
    expect(ofType(events, EVENT_TYPES.equipmentStateChanged)).toHaveLength(30);
  });

  it('flapping with a raise and clear delay: one open instance, re-raises counted as occurrences', async () => {
    const { store, run } = await setup({
      alarms: [{ id: 'a', property: 'AlarmActive', activeWhen: 'truthy', codeProperty: null, textProperty: null, severity: 'high', raiseSamples: 2, clearSamples: 3, maintenanceIds: [] }],
    });
    for (const value of [1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0]) await run({ AlarmActive: value });
    const events = await allEvents(store);
    const raised = ofType(events, EVENT_TYPES.equipmentAlarmRaised);
    const cleared = ofType(events, EVENT_TYPES.equipmentAlarmCleared);
    expect(raised).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    // Raised at the first sample of the confirming streak (tick 2), detected one cycle later
    expect(raised[0]!.data).toMatchObject({ raisedAt: '2026-10-14T00:00:02.000Z', detectedAt: '2026-10-14T00:00:03.000Z', severity: 'high' });
    expect(cleared[0]!.data).toMatchObject({ occurrences: 3, clearedAt: '2026-10-14T00:00:09.000Z', detectedAt: '2026-10-14T00:00:11.000Z', durationMs: 7000 });
  });

  it('activeWhen equals compares text and numbers', async () => {
    const { store, run } = await setup({
      alarms: [{ id: 'a', property: 'AlarmCode', activeWhen: { equals: ['ALARM', '3'] }, codeProperty: null, textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] }],
    });
    for (const value of ['OK', 'ALARM', 'OK', '3.0', 'alarm']) await run({ AlarmCode: value });
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentAlarmRaised)).toHaveLength(2);
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentAlarmCleared)).toHaveLength(2);
  });
});

describe('thresholds', () => {
  const rule = { id: 'temp', property: 'MotorTemperature', direction: 'above' as const, limit: 80, hysteresis: 5, unit: 'degC', severity: null, raiseSamples: 1, clearSamples: 1 };

  it('79–81 around 80 with a band of 5 → one crossing, no return until below 75', async () => {
    const { store, run } = await setup({ thresholds: [rule] });
    for (const value of [79, 81, 79, 81, 79, 76, 81, 74.9, 74]) await run({ MotorTemperature: value });
    const events = await allEvents(store);
    const crossed = ofType(events, EVENT_TYPES.equipmentThresholdCrossed);
    const returned = ofType(events, EVENT_TYPES.equipmentThresholdReturned);
    expect(crossed).toHaveLength(1);
    expect(returned).toHaveLength(1);
    expect(crossed[0]!.data).toMatchObject({ value: 81, limit: 80, hysteresis: 5, direction: 'above', unit: 'degC' });
    expect(returned[0]!.data).toMatchObject({ value: 74.9 });
  });

  it('a raise delay ignores single spikes; below mirrors above; non-numeric values are ignored', async () => {
    const { store, run } = await setup({
      thresholds: [
        { ...rule, raiseSamples: 2 },
        { ...rule, id: 'low', direction: 'below', limit: 10, hysteresis: 2 },
      ],
    });
    for (const value of [81, 79, 81, 'n/a', 79, 81, 81]) await run({ MotorTemperature: value });
    let crossed = ofType(await allEvents(store), EVENT_TYPES.equipmentThresholdCrossed);
    expect(crossed.map((event) => event.data['thresholdId'])).toEqual(['temp']);
    for (const value of [9, 11, 12.5]) await run({ MotorTemperature: value });
    crossed = ofType(await allEvents(store), EVENT_TYPES.equipmentThresholdCrossed);
    expect(crossed.map((event) => event.data['thresholdId'])).toEqual(['temp', 'low']);
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentThresholdReturned).map((event) => event.data['thresholdId'])).toEqual(['temp', 'low']);
  });
});

describe('counters through the detector', () => {
  it('first reading is the baseline; equal values give nothing; bad samples are counted on the step', async () => {
    const { store, run } = await setup({ counters: [{ id: 'produced', property: 'ProductionCount', kind: 'total', unit: null, max: null, maxRatePerHour: null }] });
    await run({ ProductionCount: 15230 });
    await run({ ProductionCount: 15230 });
    await run({ ProductionCount: { value: 99999, quality: 'Bad' } });
    await run({ ProductionCount: 15241 });
    await run({ ProductionCount: 3 });
    const events = ofType(await allEvents(store), EVENT_TYPES.equipmentCounterAdvanced);
    expect(events.map((event) => [event.data['from'], event.data['to'], event.data['delta']])).toEqual([
      [15230, 15241, 11],
      [15241, 3, null],
    ]);
    expect(events[0]!.data).toMatchObject({ counterKind: 'total', intervalStart: '2026-10-14T00:00:01.000Z', intervalEnd: '2026-10-14T00:00:03.000Z', excludedBadSamples: 0 });
    expect(events[1]!.data['flags']).toEqual({ reset: true, rollover: false, implausible: false, gap: false });
  });
});

describe('connection', () => {
  it('two failures → one lost; more failures nothing; a success → one restored; bad tags alone never lost', async () => {
    const { store, run } = await setup(null, { base: 'opc.tcp://user:secret@10.0.0.5:4840' });
    await run({ MachineState: 'run' });
    await run({}, ['PLC1']);
    expect(ofType(await allEvents(store), EVENT_TYPES.collectionConnectionLost)).toHaveLength(0);
    await run({}, ['PLC1']);
    await run({}, ['PLC1']);
    await run({ MachineState: 'run' });
    await run({ MachineState: { value: 'run', quality: 'BadDeviceFailure' } });
    await run({ MachineState: { value: 'run', quality: 'BadDeviceFailure' } });
    const events = await allEvents(store);
    const lost = ofType(events, EVENT_TYPES.collectionConnectionLost);
    const restored = ofType(events, EVENT_TYPES.collectionConnectionRestored);
    expect(lost).toHaveLength(1);
    expect(restored).toHaveLength(1);
    expect(lost[0]!.data).toMatchObject({ since: '2026-10-14T00:00:01.000Z', consecutiveFailures: 2, protocol: 'OPCUA', endpoint: 'opc.tcp://user:***@10.0.0.5:4840', error: 'connect ECONNREFUSED', simulated: false });
    expect(restored[0]!.data).toMatchObject({ since: '2026-10-14T00:00:04.000Z', consecutiveFailures: 3, error: null });
    // Without a package config only connection events exist — no alarm, no state
    expect(events.every((event) => event.type.startsWith('kr.vexplor.aas.collection.'))).toBe(true);
  });

  it('lostAfterFailures comes from the package config', async () => {
    const { store, run } = await setup({ connection: { lostAfterFailures: 1 } });
    await run({}, ['PLC1']);
    expect(ofType(await allEvents(store), EVENT_TYPES.collectionConnectionLost)).toHaveLength(1);
  });
});

describe('flags and blocks', () => {
  it('suppression marks every event of the cycle and persists until the tag reads false', async () => {
    const { store, run } = await setup({ ...STATE, suppressProperty: 'MaintenanceMode' });
    await run({ MachineState: 'run', MaintenanceMode: 'false' });
    await run({ MachineState: 'stop', MaintenanceMode: 1 });
    await run({ MachineState: 'run' }); // no suppress sample: still suppressed
    await run({ MachineState: 'stop', MaintenanceMode: 0 });
    const events = ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged);
    expect(events.map((event) => event.data['suppressed'])).toEqual([true, true, false]);
  });

  it('the virtual PLC interface marks events simulated; the source block names the model element', async () => {
    const { store, run } = await setup(STATE, { base: 'opc.tcp://127.0.0.1:4841/UA/Simulator' });
    await run({ MachineState: 'run' });
    await run({ MachineState: 'stop' });
    const [event] = ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged);
    expect(event!.data['source']).toEqual({
      interfaceName: 'PLC1',
      propertyName: 'MachineState',
      address: 'ns=1;s=Machine.MachineState',
      submodelId: 'https://example.com/ids/sm/OperationalData',
      idShortPath: 'MachineState',
      semanticId: 'https://example.com/ids/cd/MachineState',
      observableReference: {
        type: 'ModelReference',
        keys: [
          { type: 'Submodel', value: 'https://example.com/ids/sm/OperationalData' },
          { type: 'Property', value: 'MachineState' },
        ],
      },
      simulated: true,
    });
  });

  it('the latest sample of a cycle decides, whatever order the samples arrive in', async () => {
    const { store, clock, detector } = await setup(STATE);
    await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    const cycle = clock.cycle({ MachineState: 'stop' });
    const later = { ...cycle.samples[0]!, valueText: 'run', receivedAt: '2026-10-14T00:00:01.500Z', observedAt: '2026-10-14T00:00:01.500Z' };
    // The earlier 'stop' first, the later 'run' second: the later one decides, so the state stays run
    await detector.onPackageCycle({ ...cycle, samples: [cycle.samples[0]!, later] });
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentStateChanged)).toEqual([]);
  });

  it('a property name that is not unique in the model is not pinned to one of the candidates', async () => {
    const { store, record } = await setup(STATE);
    const environment = environmentWith(PROPS);
    // A second submodel holding another MachineState — the overlay refuses such names, so must the event
    environment.submodels!.push({ ...environment.submodels![0]!, id: 'https://example.com/ids/sm/Other', idShort: 'Other' });
    const clock = new CycleClock(record, environment, [iface('PLC1', PROPS)]);
    const detector = detectorFor(store);
    await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    const [event] = await detector.onPackageCycle(clock.cycle({ MachineState: 'stop' }));
    expect(event!.data['source']).toMatchObject({ submodelId: null, idShortPath: null, semanticId: null, observableReference: null, address: 'ns=1;s=Machine.MachineState' });
  });

  it('a package without a global asset id still emits, without subject, ids keyed by the package', async () => {
    const { store, record, run } = await setup(STATE, { globalAssetId: null });
    await run({ MachineState: 'run' });
    await run({ MachineState: 'stop' });
    const [event] = await allEvents(store);
    expect(event!.subject).toBeUndefined();
    expect(event!.packageId).toBe(record.id);
  });

  it('the runtime state is written only when it changed', async () => {
    const { store, record, run } = await setup(STATE);
    await run({ MachineState: 'run' });
    const writes: unknown[] = [];
    const original = store.putRuntimeState.bind(store);
    (store as { putRuntimeState: typeof store.putRuntimeState }).putRuntimeState = async (key, value, packageId) => {
      writes.push(value);
      return original(key, value, packageId);
    };
    const detector = detectorFor(store);
    const clock = new CycleClock(record, environmentWith(PROPS), [iface('PLC1', PROPS)], 1000, Date.parse('2026-10-14T01:00:00.000Z'));
    await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }));
    expect(writes).toHaveLength(0);
    await detector.onPackageCycle(clock.cycle({ MachineState: 'stop' }));
    // A cycle with events writes twice: the new state with the events as pending, then the state with pending cleared
    expect(writes).toHaveLength(2);
    expect((writes[0] as { pending?: unknown[] }).pending).toHaveLength(1);
    expect((writes[1] as { pending?: unknown[] }).pending).toBeUndefined();
  });

  it('a deleted package yields nothing', async () => {
    const { store, record, clock, detector } = await setup(STATE);
    await store.deletePackage(record.id);
    expect(await detector.onPackageCycle(clock.cycle({ MachineState: 'run' }))).toEqual([]);
  });

  it('the scenario builder covers every runtime event type', async () => {
    const types = new Set((await runtimeEventScenario()).map((event) => event.type));
    expect([...types].sort()).toEqual(
      [
        EVENT_TYPES.equipmentStateChanged,
        EVENT_TYPES.equipmentAlarmRaised,
        EVENT_TYPES.equipmentAlarmCleared,
        EVENT_TYPES.equipmentCounterAdvanced,
        EVENT_TYPES.equipmentThresholdCrossed,
        EVENT_TYPES.equipmentThresholdReturned,
        EVENT_TYPES.collectionConnectionLost,
        EVENT_TYPES.collectionConnectionRestored,
      ].sort(),
    );
  });
});

describe('crash consistency (review M1)', () => {
  const CONFIG = {
    ...STATE,
    alarms: [{ id: 'a1', property: 'AlarmActive', activeWhen: 'truthy' as const, codeProperty: null, textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] }],
    counters: [{ id: 'produced', property: 'ProductionCount', kind: 'total' as const, unit: null, max: null, maxRatePerHour: null }],
  };

  /** Fails the n-th call (1-based) of a store method once */
  function failNth(store: RuntimeStore, method: 'putRuntimeState' | 'appendEvents', n: number): void {
    const real = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
    let calls = 0;
    (store as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      calls += 1;
      if (calls === n) throw new Error('store hiccup');
      return real(...args);
    };
  }

  async function scenario(fail: (store: RuntimeStore) => void) {
    const { store, run } = await setup(CONFIG);
    await run({ MachineState: 'run', AlarmActive: 0, ProductionCount: 100 });
    fail(store);
    await expect(run({ MachineState: 'stop', AlarmActive: 1, ProductionCount: 110 })).rejects.toThrow('store hiccup');
    // The device still shows the same state; the counter moved on
    await run({ MachineState: 'stop', AlarmActive: 1, ProductionCount: 112 });
    await run({ MachineState: 'stop', AlarmActive: 0, ProductionCount: 112 });
    const events = await allEvents(store);
    return {
      deltas: ofType(events, EVENT_TYPES.equipmentCounterAdvanced).map((event) => event.data['delta'] as number),
      states: ofType(events, EVENT_TYPES.equipmentStateChanged).length,
      raised: ofType(events, EVENT_TYPES.equipmentAlarmRaised).map((event) => event.data['alarmInstanceId']),
      cleared: ofType(events, EVENT_TYPES.equipmentAlarmCleared).map((event) => event.data['alarmInstanceId']),
    };
  }

  const expectConsistent = (result: Awaited<ReturnType<typeof scenario>>): void => {
    expect(result.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(12);
    expect(result.states).toBe(1);
    expect(result.raised).toHaveLength(1);
    expect(result.cleared).toEqual(result.raised);
  };

  it('the state write fails: no event goes out, the next cycle measures from the old state', async () => {
    const result = await scenario((store) => failNth(store, 'putRuntimeState', 1));
    expectConsistent(result);
    expect(result.deltas).toEqual([12]);
  });

  it('the append fails after the state was saved: the next cycle appends the pending events first', async () => {
    const result = await scenario((store) => failNth(store, 'appendEvents', 1));
    expectConsistent(result);
    expect(result.deltas).toEqual([10, 2]);
  });

  it('clearing pending fails after the append: the next cycle re-appends and the log skips duplicates', async () => {
    const result = await scenario((store) => failNth(store, 'putRuntimeState', 2));
    expectConsistent(result);
    expect(result.deltas).toEqual([10, 2]);
  });

  it('the state with pending is flushed to disk before any event is appended', async () => {
    const { store, run } = await setup(CONFIG);
    await run({ MachineState: 'run', AlarmActive: 0, ProductionCount: 100 });
    const calls: string[] = [];
    const put = store.putRuntimeState.bind(store);
    const append = store.appendEvents.bind(store);
    Object.assign(store, {
      putRuntimeState: async (key: string, value: unknown, packageId?: string) => {
        calls.push((value as { pending?: unknown[] }).pending ? 'put+pending' : 'put');
        return put(key, value, packageId);
      },
      appendEvents: async (events: Parameters<typeof append>[0]) => {
        calls.push('append');
        return append(events);
      },
      flush: async () => void calls.push('flush'),
    });
    await run({ MachineState: 'stop', AlarmActive: 1, ProductionCount: 110 });
    expect(calls).toEqual(['put+pending', 'flush', 'append', 'put']);
  });
});

describe('removed rules (review L3)', () => {
  it('an open alarm and an open threshold whose rules are removed are closed with reason rule-removed', async () => {
    const { store, record, run } = await setup({
      alarms: [{ id: 'a1', property: 'AlarmActive', activeWhen: 'truthy', codeProperty: 'AlarmCode', textProperty: null, severity: 'high', raiseSamples: 1, clearSamples: 1, maintenanceIds: ['MI-9'] }],
      thresholds: [{ id: 't1', property: 'MotorTemperature', direction: 'above', limit: 80, hysteresis: 5, unit: 'degC', severity: null, raiseSamples: 1, clearSamples: 1 }],
    });
    await run({ AlarmActive: 1, AlarmCode: 'E-1', MotorTemperature: 90 });
    await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1' }, 1);
    await run({ AlarmActive: 1, MotorTemperature: 90 });
    const events = await allEvents(store);
    const [raised] = ofType(events, EVENT_TYPES.equipmentAlarmRaised);
    const [cleared] = ofType(events, EVENT_TYPES.equipmentAlarmCleared);
    expect(cleared!.data).toMatchObject({
      reason: 'rule-removed',
      alarmInstanceId: raised!.data['alarmInstanceId'],
      code: 'E-1',
      severity: 'high',
      maintenanceIds: ['MI-9'],
      clearedAt: '2026-10-14T00:00:01.000Z',
      durationMs: 1000,
    });
    expect((cleared!.data['source'] as { propertyName: string }).propertyName).toBe('AlarmActive');
    const [returned] = ofType(events, EVENT_TYPES.equipmentThresholdReturned);
    expect(returned!.data).toMatchObject({ reason: 'rule-removed', thresholdId: 't1', value: 90, limit: 80, direction: 'above' });
    // Normal closings carry no reason; a closed track is not closed twice
    await run({ AlarmActive: 0 });
    expect(ofType(await allEvents(store), EVENT_TYPES.equipmentAlarmCleared)).toHaveLength(1);
  });

  it('a closed track of a removed rule disappears without an event', async () => {
    const { store, record, run } = await setup({
      alarms: [{ id: 'a1', property: 'AlarmActive', activeWhen: 'truthy', codeProperty: null, textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] }],
    });
    await run({ AlarmActive: 0 });
    await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1' }, 1);
    await run({ AlarmActive: 1 });
    expect(await allEvents(store)).toEqual([]);
  });
});

describe('connection error text (review L4)', () => {
  it('credentials inside the interface error are masked', async () => {
    const { store, record } = await setup(null);
    const clock = new CycleClock(record, environmentWith(PROPS), [iface('PLC1', PROPS, 'mqtt://plant:s3cret@10.0.0.9:1883')]);
    const detector = detectorFor(store);
    for (let i = 0; i < 2; i++) {
      const cycle = clock.cycle({}, ['PLC1']);
      cycle.cycle.interfaces[0]!.error = 'connect ECONNREFUSED mqtt://plant:s3cret@10.0.0.9:1883 (after 5000 ms)';
      await detector.onPackageCycle(cycle);
    }
    const [lost] = ofType(await allEvents(store), EVENT_TYPES.collectionConnectionLost);
    expect(lost!.data['error']).toBe('connect ECONNREFUSED mqtt://plant:***@10.0.0.9:1883 (after 5000 ms)');
    expect(JSON.stringify(await store.getRuntimeState(detectorStateKey(record.id)))).not.toContain('s3cret');
  });
});

describe('folder store durability (review M1)', () => {
  it('the detector state is on disk before the cycle returns, so a restarted server does not re-announce', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FolderStore } = await import('@aas/store');
    const dir = mkdtempSync(join(tmpdir(), 'aas-detector-'));
    try {
      const store = new FolderStore(dir);
      await store.init();
      const record = await seededPackage(store);
      await store.putPackageIntegrationConfig(record.id, { schema: 'vexplor.packageIntegrationConfig/1', ...STATE });
      const clock = new CycleClock(record, environmentWith(PROPS), [iface('PLC1', PROPS)]);
      await detectorFor(store).onPackageCycle(clock.cycle({ MachineState: 'run' }));
      // A state write just happened, so the next one is coalesced for about a second
      await store.flush();
      await detectorFor(store).onPackageCycle(clock.cycle({ MachineState: 'stop' }));
      // Read the file at once — the coalesced (1 s) write must not be what makes the state durable
      const onDisk = JSON.parse(readFileSync(join(dir, 'integration-state.json'), 'utf8')) as { state: Record<string, { value: { state?: { value: string } } }> };
      expect(onDisk.state[detectorStateKey(record.id)]!.value.state!.value).toBe('stop');

      const restarted = new FolderStore(dir);
      await restarted.init();
      expect(await detectorFor(restarted).onPackageCycle(clock.cycle({ MachineState: 'stop' }))).toEqual([]);
      expect(ofType((await restarted.readEvents({ after: 0, limit: 100 })).items, EVENT_TYPES.equipmentStateChanged)).toHaveLength(1);
      await restarted.flush();
      await store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
