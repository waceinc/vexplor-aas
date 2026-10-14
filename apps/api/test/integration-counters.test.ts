/**
 * Counter arithmetic (D13, test plan "MES B counter", CMMS T1–T5): never invent a number.
 */
import { describe, expect, it } from 'vitest';
import { counterReadings, counterStep, counterSteps, isGoodQuality, numericValue, summarizeSteps, type CounterReading } from '../src/integration/runtime/counters.js';

const at = (seconds: number): string => new Date(Date.parse('2026-10-14T00:00:00.000Z') + seconds * 1000).toISOString();
const reading = (value: number, seconds: number): CounterReading => ({ value, at: at(seconds) });
const PLAIN = { max: null, maxRatePerHour: null };
const FRESH = 5 * 60_000;

describe('one step', () => {
  it('an increase is the difference; no change is no step', () => {
    expect(counterStep(reading(15230, 0), reading(15241, 30), PLAIN, FRESH)).toEqual({
      from: 15230,
      to: 15241,
      delta: 11,
      intervalStart: at(0),
      intervalEnd: at(30),
      flags: { reset: false, rollover: false, implausible: false, gap: false },
    });
    expect(counterStep(reading(5, 0), reading(5, 30), PLAIN, FRESH)).toBeUndefined();
  });

  it('a decrease with a configured max is a rollover: 65530 → 4 with max 65535 is 10', () => {
    const step = counterStep(reading(65530, 0), reading(4, 30), { max: 65535, maxRatePerHour: null }, FRESH)!;
    expect(step.delta).toBe(10);
    expect(step.flags).toMatchObject({ rollover: true, reset: false });
  });

  it('a decrease without max is a reset with an unknown delta — never a guessed wrap', () => {
    const step = counterStep(reading(65530, 0), reading(4, 30), PLAIN, FRESH)!;
    expect(step.delta).toBeNull();
    expect(step.flags).toMatchObject({ reset: true, rollover: false });
  });

  it('a previous value above the configured max cannot be a rollover — it is a reset', () => {
    const step = counterStep(reading(70000, 0), reading(4, 30), { max: 65535, maxRatePerHour: null }, FRESH)!;
    expect(step.flags.reset).toBe(true);
    expect(step.delta).toBeNull();
  });

  it('faster than maxRatePerHour is implausible with an unknown delta', () => {
    // 2 run hours in 30 minutes at most 1 per hour → implausible
    const fast = counterStep(reading(100, 0), reading(102, 1800), { max: null, maxRatePerHour: 1 }, FRESH)!;
    expect(fast).toMatchObject({ delta: null, flags: { implausible: true } });
    const fine = counterStep(reading(100, 0), reading(100.5, 1800), { max: null, maxRatePerHour: 1 }, FRESH)!;
    expect(fine).toMatchObject({ delta: 0.5, flags: { implausible: false } });
  });

  it('a previous reading older than the fresh window flags gap but keeps the device count', () => {
    const step = counterStep(reading(10, 0), reading(25, 600), PLAIN, FRESH)!;
    expect(step).toMatchObject({ delta: 15, flags: { gap: true } });
  });
});

describe('sequences', () => {
  it('a monotonic sequence sums to last − first', () => {
    const readings = [reading(0, 0), reading(3, 1), reading(3, 2), reading(10, 3), reading(11, 4)];
    const summary = summarizeSteps(counterSteps(readings, PLAIN, FRESH));
    expect(summary).toEqual({ delta: 11, resets: 0, flags: { reset: false, rollover: false, implausible: false, gap: false } });
  });

  it('one reset in a sequence makes the total unknown and is counted', () => {
    const readings = [reading(100, 0), reading(110, 1), reading(2, 2), reading(5, 3)];
    expect(summarizeSteps(counterSteps(readings, PLAIN, FRESH))).toMatchObject({ delta: null, resets: 1, flags: { reset: true } });
  });

  it('a baseline before the window is the start of the first step', () => {
    expect(counterSteps([reading(15, 10)], PLAIN, FRESH, reading(10, 0)).map((step) => step.delta)).toEqual([5]);
  });

  it('bad-quality and non-numeric samples are excluded and counted', () => {
    const sample = (value: number | string, quality?: string) => ({
      interfaceName: 'PLC1',
      propertyName: 'Count',
      observedAt: at(0),
      receivedAt: at(typeof value === 'number' ? value : 99),
      ...(typeof value === 'number' ? { valueNumber: value } : { valueText: value }),
      ...(quality === undefined ? {} : { quality }),
    });
    const { readings, excludedBadSamples } = counterReadings([sample(3), sample(1, 'Good'), sample(2, 'BadSensorFailure'), sample('n/a'), sample(4, 'GoodLocalOverride')]);
    expect(readings.map((r) => r.value)).toEqual([1, 3, 4]);
    expect(excludedBadSamples).toBe(2);
  });

  it('quality and number helpers', () => {
    expect(isGoodQuality(undefined)).toBe(true);
    expect(isGoodQuality('Good')).toBe(true);
    expect(isGoodQuality('good')).toBe(true);
    expect(isGoodQuality('Uncertain')).toBe(false);
    expect(numericValue({ valueText: ' 12.5 ' })).toBe(12.5);
    expect(numericValue({ valueText: '12abc' })).toBeUndefined();
    expect(numericValue({ valueNumber: Number.NaN, valueText: '7' })).toBe(7);
  });
});
