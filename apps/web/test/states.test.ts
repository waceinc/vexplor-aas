/**
 * Equipment state: value normalization, state tag selection, daily segments (Gantt).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_RULES, dayWindow, normalizeState, pickStateTag, stateTimeline, stateTotals } from '../src/components/collection/states.js';

const MIN = 60_000;

describe('equipment state', () => {
  it('maps text / numbers / booleans to running / stopped / alarm / powered off; anything outside the rules is not made up', () => {
    expect(normalizeState({ valueText: '가동' })).toBe('run');
    expect(normalizeState({ valueText: 'Running' })).toBe('run');
    expect(normalizeState({ valueNumber: 1 })).toBe('run');
    expect(normalizeState({ valueNumber: 0 })).toBe('stop');
    expect(normalizeState({ valueText: 'false' })).toBe('stop');
    expect(normalizeState({ valueText: 'FAULT' })).toBe('alarm');
    expect(normalizeState({ valueText: 'Power Off' })).toBe('off');
    expect(normalizeState({ valueNumber: 3 })).toBeUndefined();
    expect(normalizeState({ valueText: '' })).toBeUndefined();
    // customer rule: 3 means alarm
    expect(normalizeState({ valueNumber: 3 }, { ...DEFAULT_STATE_RULES, alarm: ['3'] })).toBe('alarm');
  });

  it('state tag by name: picked only when exactly one matches', () => {
    expect(pickStateTag(['MotorSpeed', 'Machine_Status', 'Temp'])).toBe('Machine_Status');
    expect(pickStateTag(['가동상태', 'Temp'])).toBe('가동상태');
    expect(pickStateTag(['Status', 'RunState'])).toBeUndefined();
    expect(pickStateTag(['MotorSpeed'])).toBeUndefined();
  });

  it('a value lasts until the next value, at most the hold time; gaps are no data, same states merge', () => {
    const start = 0;
    const end = 120 * MIN;
    const segments = stateTimeline(
      [
        { at: -2 * MIN, state: 'run' }, // value before the window: within the hold time, so it fills the window start
        { at: 3 * MIN, state: 'run' },
        { at: 10 * MIN, state: 'stop' },
        { at: 20 * MIN, state: 'alarm' }, // no value after it: disconnected from minute 25
        { at: 60 * MIN, state: undefined }, // undetermined
      ],
      start,
      end,
      5 * MIN,
    );
    expect(segments).toEqual([
      { from: 0, to: 8 * MIN, state: 'run' },
      { from: 8 * MIN, to: 10 * MIN, state: 'none' },
      { from: 10 * MIN, to: 15 * MIN, state: 'stop' },
      { from: 15 * MIN, to: 20 * MIN, state: 'none' },
      { from: 20 * MIN, to: 25 * MIN, state: 'alarm' },
      { from: 25 * MIN, to: 60 * MIN, state: 'none' },
      { from: 60 * MIN, to: 65 * MIN, state: 'unknown' },
      { from: 65 * MIN, to: 120 * MIN, state: 'none' },
    ]);
    const totals = stateTotals(segments);
    expect(totals.run).toBe(8 * MIN);
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(end - start); // covers the window with no gaps
  });

  it('with no values the whole day is no data, and the window is 24 hours from the start of that day', () => {
    expect(stateTimeline([], 0, 10, 5)).toEqual([{ from: 0, to: 10, state: 'none' }]);
    const { start, end } = dayWindow(new Date(2026, 9, 14, 3, 0), 8);
    expect(new Date(start).getHours()).toBe(8);
    expect(new Date(start).getDate()).toBe(14);
    expect(end - start).toBe(24 * 3600_000);
  });
});

describe('state duration formatting', () => {
  it('under 1 minute shows "under 1 minute", not "0 minutes"', async () => {
    const { duration } = await import('../src/components/collection/DailyStates.js');
    expect(duration(20_000)).toBe('1분 미만');
    expect(duration(90 * 60_000)).toBe('1시간 30분');
    expect(duration(5 * 60_000)).toBe('5분');
  });
});
