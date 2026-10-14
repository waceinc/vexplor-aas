/**
 * 값 신선도 판정 — 받는 중 · 끊김 · 값 없음(components/collection/freshness.ts).
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

describe('값 신선도', () => {
  it('창 안에 들어온 값은 받는 중, 밖이면 끊김, 없으면 값 없음', () => {
    expect(freshnessOf(value({ receivedAt: '2026-10-13T09:08:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('live');
    expect(freshnessOf(value({ receivedAt: '2026-10-13T08:50:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('stale');
    expect(freshnessOf(undefined, now, FRESH_WINDOW_MS).kind).toBe('none');
  });

  it('🔴 장비 시각이 멈춰 있어도 방금 읽었으면 받는 중이다 — 판정 근거는 수신 시각', () => {
    const constant = value({ observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-10-13T09:09:30.000Z' });
    expect(freshnessOf(constant, now, FRESH_WINDOW_MS).kind).toBe('live');
  });

  it('수신 시각이 없는 옛 기록은 장비 시각으로 대신한다', () => {
    expect(freshnessOf(value({ observedAt: '2026-10-13T09:09:00.000Z' }), now, FRESH_WINDOW_MS)).toEqual({ kind: 'live', ageMs: 60_000 });
    expect(freshnessOf(value({ observedAt: '2026-10-13T08:00:00.000Z' }), now, FRESH_WINDOW_MS).kind).toBe('stale');
  });

  it('자동 수집이 느리면 창을 넓힌다 — 간격의 3배와 5분 중 큰 쪽', () => {
    expect(freshWindowMs(undefined)).toBe(FRESH_WINDOW_MS);
    expect(freshWindowMs(10_000)).toBe(FRESH_WINDOW_MS);
    expect(freshWindowMs(10 * 60_000)).toBe(30 * 60_000);
    // 10분 간격 수집의 8분 전 값 — 5분 창이면 끊김이지만 넓힌 창에서는 받는 중
    const slow = value({ receivedAt: '2026-10-13T09:02:00.000Z' });
    expect(freshnessOf(slow, now, FRESH_WINDOW_MS).kind).toBe('stale');
    expect(freshnessOf(slow, now, freshWindowMs(10 * 60_000)).kind).toBe('live');
  });

  it('지난 시간은 사람 말로', () => {
    expect(ageLabel(2_000)).toBe('방금');
    expect(ageLabel(12_000)).toBe('12초 전');
    expect(ageLabel(5 * 60_000)).toBe('5분 전');
    expect(ageLabel(3 * 3_600_000)).toBe('3시간 전');
    expect(ageLabel(3 * 86_400_000)).toBe('3일 전');
  });

  it('합계', () => {
    expect(tallyFreshness(['live', 'live', 'stale', 'none'])).toEqual({ live: 2, stale: 1, none: 1 });
  });
});
