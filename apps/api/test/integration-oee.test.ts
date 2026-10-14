/**
 * Calendar windows, segments and OEE inputs (test plan CMMS T18, MES §4 oee-inputs).
 *
 * Important: the totals must equal what the web bar computes from the same values — the comparison below calls the
 *    core functions the bar calls, on the same rows, so a drift between server and bar fails here.
 */
import { DEFAULT_STATE_RULES, normalizeState, parsePackageIntegrationConfig, stateTimeline, stateTotals, type PackageIntegrationConfig } from '@aas/core';
import type { CollectedValue } from '@aas/store';
import { describe, expect, it } from 'vitest';
import { computeOeeInputs } from '../src/integration/runtime/oee.js';
import { computeSegments, readWindow, ruleSetHash } from '../src/integration/runtime/segments.js';
import { addDays, dayWindow, periodsBetween, productionDayOf, shiftWindow, zonedInstant } from '../src/integration/runtime/zoned.js';
import { runtimeStore, seededPackage } from './helpers/integration-runtime.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('zoned windows', () => {
  it('the production day starts at 08:00 KST = 23:00 UTC the day before', () => {
    const window = dayWindow('Asia/Seoul', '2026-10-14', 8);
    expect(iso(window.start)).toBe('2026-10-13T23:00:00.000Z');
    expect(iso(window.end)).toBe('2026-10-14T23:00:00.000Z');
    // 07:59 KST on the 15th still belongs to the production day of the 14th
    expect(productionDayOf('Asia/Seoul', Date.parse('2026-10-14T22:59:00.000Z'), 8)).toBe('2026-10-14');
    expect(productionDayOf('Asia/Seoul', Date.parse('2026-10-14T23:00:00.000Z'), 8)).toBe('2026-10-15');
  });

  it('Europe/Berlin: the day containing the October change is 25 hours, the March one 23', () => {
    const autumn = dayWindow('Europe/Berlin', '2026-10-24', 8);
    expect(iso(autumn.start)).toBe('2026-10-24T06:00:00.000Z');
    expect(iso(autumn.end)).toBe('2026-10-25T07:00:00.000Z');
    expect((autumn.end - autumn.start) / 3_600_000).toBe(25);
    const spring = dayWindow('Europe/Berlin', '2026-03-28', 8);
    expect((spring.end - spring.start) / 3_600_000).toBe(23);
    // A wall-clock time inside the spring gap resolves to an instant, not NaN
    expect(Number.isFinite(zonedInstant('Europe/Berlin', { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }))).toBe(true);
  });

  it('an overnight shift ends the next calendar day', () => {
    const night = shiftWindow('Asia/Seoul', '2026-10-14', { name: 'B', start: '20:00', end: '08:00' });
    expect(iso(night.start)).toBe('2026-10-14T11:00:00.000Z');
    expect(iso(night.end)).toBe('2026-10-14T23:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('periods: hours, production days and shifts clipped to the window', () => {
    const from = Date.parse('2026-10-14T00:30:00.000Z');
    const to = Date.parse('2026-10-14T03:00:00.000Z');
    expect(periodsBetween('Asia/Seoul', from, to, 'hour', 8, []).map((p) => iso(p.start))).toEqual([
      '2026-10-14T00:30:00.000Z',
      '2026-10-14T01:00:00.000Z',
      '2026-10-14T02:00:00.000Z',
    ]);
    const days = periodsBetween('Asia/Seoul', Date.parse('2026-10-13T23:00:00.000Z'), Date.parse('2026-10-15T23:00:00.000Z'), 'day', 8, []);
    expect(days.map((p) => [iso(p.start), iso(p.end)])).toEqual([
      ['2026-10-13T23:00:00.000Z', '2026-10-14T23:00:00.000Z'],
      ['2026-10-14T23:00:00.000Z', '2026-10-15T23:00:00.000Z'],
    ]);
    const shifts = [
      { name: 'A', start: '08:00', end: '20:00' },
      { name: 'B', start: '20:00', end: '08:00' },
    ];
    const byShift = periodsBetween('Asia/Seoul', Date.parse('2026-10-13T23:00:00.000Z'), Date.parse('2026-10-14T23:00:00.000Z'), 'shift', 8, shifts);
    expect(byShift.map((p) => p.label)).toEqual(['A', 'B']);
    expect(periodsBetween('Asia/Seoul', from, to, 'shift', 8, [])).toEqual([]);
  });
});

/** Writes state and counter values at given minute offsets from the window start */
async function seeded(rows: { minute: number; state?: string; count?: number; quality?: string }[], start: number) {
  const store = await runtimeStore();
  const record = await seededPackage(store);
  const values: CollectedValue[] = [];
  for (const row of rows) {
    const at = iso(start + row.minute * 60_000);
    const base = { packageId: record.id, interfaceName: 'PLC1', observedAt: at, receivedAt: at, ...(row.quality ? { quality: row.quality } : {}) };
    if (row.state !== undefined) values.push({ ...base, propertyName: 'MachineState', valueText: row.state });
    if (row.count !== undefined) values.push({ ...base, propertyName: 'ProductionCount', valueNumber: row.count });
  }
  await store.appendValues(record.id, values);
  return { store, record, values };
}

const CONFIG = ((): PackageIntegrationConfig => {
  const parsed = parsePackageIntegrationConfig({
    schema: 'vexplor.packageIntegrationConfig/1',
    state: { property: 'MachineState' },
    counters: [
      { id: 'produced', property: 'ProductionCount', kind: 'total' },
      { id: 'bad', property: 'RejectCount', kind: 'reject' },
    ],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
})();

describe('segments and OEE inputs', () => {
  const window = dayWindow('Asia/Seoul', '2026-10-14', 8);
  const hold = 5 * 60_000;

  it('segment totals equal the bar computed with the same core functions on the same rows', async () => {
    const rows = [
      { minute: 0, state: 'run' },
      { minute: 2, state: 'run' },
      { minute: 4, state: '알람' },
      { minute: 6, state: 'stop' },
      { minute: 30, state: 'Mode 7' },
      { minute: 31, state: 'run' },
    ];
    const { store, record, values } = await seeded(rows, window.start);
    const result = await computeSegments(store, record.id, { property: 'MachineState', interfaceName: null }, DEFAULT_STATE_RULES, window.start, window.start + 3_600_000, hold);
    const bar = stateTotals(stateTimeline(values.map((v) => ({ at: Date.parse(v.receivedAt!), state: normalizeState(v, DEFAULT_STATE_RULES) })), window.start, window.start + 3_600_000, hold));
    expect(result.totals).toEqual(bar);
    expect(result.totals.alarm).toBe(2 * 60_000);
    expect(result.totals.unknown).toBe(60_000);
    expect(result.totals.none).toBeGreaterThan(0);
  });

  it('OEE inputs: durations, coverage, counter deltas, and no OEE number', async () => {
    const rows = [
      { minute: -1, count: 100 }, // baseline just before the window
      { minute: 0, state: 'run', count: 100 },
      { minute: 3, state: 'run', count: 130 },
      { minute: 6, state: 'stop', count: 150 },
      { minute: 9, state: 'run', count: 150, quality: 'BadSensorFailure' },
    ];
    const { store, record } = await seeded(rows, window.start);
    const end = window.start + 20 * 60_000;
    const inputs = await computeOeeInputs(store, record.id, CONFIG, DEFAULT_STATE_RULES, { start: window.start, end, timezone: 'Asia/Seoul' }, hold, 60_000);
    expect(inputs).toMatchObject({ runMs: 6 * 60_000 + 5 * 60_000, stopMs: 3 * 60_000, resolutionMs: 60_000, ruleSetHash: ruleSetHash(DEFAULT_STATE_RULES) });
    expect(inputs.noDataMs).toBe(20 * 60_000 - inputs.runMs - inputs.stopMs);
    expect(inputs.coverage).toBeCloseTo(1 - inputs.noDataMs / (20 * 60_000), 4);
    expect(inputs.produced).toEqual({ delta: 50, resets: 0, counterId: 'produced' });
    // A configured counter without any value in the window: unknown, not a measured zero
    expect(inputs.reject).toEqual({ delta: null, resets: 0, counterId: 'bad' });
    expect(inputs.good).toBeNull();
    expect(Object.keys(inputs).some((key) => /oee/i.test(key))).toBe(false);
  });

  it('a counter reset inside the window makes the produced delta unknown and is counted', async () => {
    const rows = [
      { minute: 0, state: 'run', count: 500 },
      { minute: 1, count: 510 },
      { minute: 2, count: 3 },
      { minute: 3, count: 9 },
    ];
    const { store, record } = await seeded(rows, window.start);
    const inputs = await computeOeeInputs(store, record.id, CONFIG, DEFAULT_STATE_RULES, { start: window.start, end: window.start + 600_000, timezone: 'Asia/Seoul' }, hold, null);
    expect(inputs.produced).toEqual({ delta: null, resets: 1, counterId: 'produced' });
  });

  it('readWindow pages through more values than one store read returns, oldest first', async () => {
    const store = await runtimeStore();
    const record = await seededPackage(store);
    const start = Date.parse('2026-10-14T00:00:00.000Z');
    const many: CollectedValue[] = Array.from({ length: 1500 }, (_, i) => {
      const at = iso(start + i * 1000);
      return { packageId: record.id, interfaceName: 'PLC1', propertyName: 'MachineState', observedAt: at, receivedAt: at, valueText: 'run' };
    });
    await store.appendValues(record.id, many);
    // A store that returns at most 400 rows per read, whatever the limit — forces several pages
    const limited = { readValues: (id: string, query?: Parameters<typeof store.readValues>[1]) => store.readValues(id, { ...query, limit: Math.min(400, query?.limit ?? 400) }) };
    const pageSized = await readWindowWithPage(limited, record.id, iso(start), iso(start + 1500 * 1000));
    expect(pageSized.values).toHaveLength(1500);
    expect(pageSized.values[0]!.receivedAt).toBe(iso(start));
    expect(pageSized.values.at(-1)!.receivedAt).toBe(iso(start + 1499 * 1000));
  });
});

/** readWindow with the page size the fake store enforces — the real page constant is larger than the fake's cap */
async function readWindowWithPage(store: Parameters<typeof readWindow>[0], packageId: string, from: string, to: string) {
  return readWindow(store, packageId, { propertyName: 'MachineState' }, from, to, 400);
}
