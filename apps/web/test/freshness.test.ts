/**
 * Value freshness: receiving / disconnected / no value (components/collection/freshness.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CollectedValueView } from '../src/api.js';
import { ageLabel, freshnessOf, freshWindowMs, FRESH_WINDOW_MS, tallyFreshness } from '../src/components/collection/freshness.js';

const now = Date.parse('2026-10-13T09:10:00.000Z');
const value = (patch: Partial<CollectedValueView>): CollectedValueView => ({
  interfaceName: 'I',
  propertyName: 'P',
  observedAt: '2026-10-13T09:09:00.000Z',
  ...patch,
});

describe('value freshness', () => {
  it('a value inside the window is receiving, outside is disconnected, missing is no value', () => {
    expect(freshnessOf(value({ receivedAt: '2026-10-13T09:08:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('live');
    expect(freshnessOf(value({ receivedAt: '2026-10-13T08:50:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('stale');
    expect(freshnessOf(undefined, now, FRESH_WINDOW_MS).kind).toBe('none');
  });

  it('Important: just read means receiving even if the device clock is frozen (judged by receive time)', () => {
    const constant = value({ observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-10-13T09:09:30.000Z' });
    expect(freshnessOf(constant, now, FRESH_WINDOW_MS).kind).toBe('live');
  });

  it('old records without a receive time fall back to the device time', () => {
    expect(freshnessOf(value({ observedAt: '2026-10-13T09:09:00.000Z' }), now, FRESH_WINDOW_MS)).toEqual({ kind: 'live', ageMs: 60_000 });
    expect(freshnessOf(value({ observedAt: '2026-10-13T08:00:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('stale');
  });

  it('slow auto collection widens the window: the larger of 3x the interval and 5 minutes', () => {
    expect(freshWindowMs(undefined)).toBe(FRESH_WINDOW_MS);
    expect(freshWindowMs(10_000)).toBe(FRESH_WINDOW_MS);
    expect(freshWindowMs(10 * 60_000)).toBe(30 * 60_000);
    // an 8-minute-old value from 10-minute collection: disconnected in a 5-minute window, receiving in the widened one
    const slow = value({ receivedAt: '2026-10-13T09:02:00.000Z' });
    expect(freshnessOf(slow, now, FRESH_WINDOW_MS).kind).toBe('stale');
    expect(freshnessOf(slow, now, freshWindowMs(10 * 60_000)).kind).toBe('live');
  });

  it('elapsed time in human words', () => {
    expect(ageLabel(2_000)).toBe('방금');
    expect(ageLabel(12_000)).toBe('12초 전');
    expect(ageLabel(5 * 60_000)).toBe('5분 전');
    expect(ageLabel(3 * 3_600_000)).toBe('3시간 전');
    expect(ageLabel(3 * 86_400_000)).toBe('3일 전');
  });

  it('totals', () => {
    expect(tallyFreshness(['live', 'live', 'stale', 'none'])).toEqual({ live: 2, stale: 1, none: 1 });
  });
});
