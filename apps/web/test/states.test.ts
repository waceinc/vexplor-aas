/**
 * 설비 상태 — 값 정규화 · 상태 태그 고르기 · 하루 구간(간트).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_RULES, dayWindow, normalizeState, pickStateTag, stateTimeline, stateTotals } from '../src/components/collection/states.js';

const MIN = 60_000;

describe('설비 상태', () => {
  it('글자 · 숫자 · 참거짓을 가동 · 정지 · 알람 · 전원 꺼짐으로 — 규칙에 없으면 지어내지 않는다', () => {
    expect(normalizeState({ valueText: '가동' })).toBe('run');
    expect(normalizeState({ valueText: 'Running' })).toBe('run');
    expect(normalizeState({ valueNumber: 1 })).toBe('run');
    expect(normalizeState({ valueNumber: 0 })).toBe('stop');
    expect(normalizeState({ valueText: 'false' })).toBe('stop');
    expect(normalizeState({ valueText: 'FAULT' })).toBe('alarm');
    expect(normalizeState({ valueText: 'Power Off' })).toBe('off');
    expect(normalizeState({ valueNumber: 3 })).toBeUndefined();
    expect(normalizeState({ valueText: '' })).toBeUndefined();
    // 고객 규칙 — 3 을 알람으로
    expect(normalizeState({ valueNumber: 3 }, { ...DEFAULT_STATE_RULES, alarm: ['3'] })).toBe('alarm');
  });

  it('상태 태그는 이름으로 — 하나만 맞을 때만 고른다', () => {
    expect(pickStateTag(['MotorSpeed', 'Machine_Status', 'Temp'])).toBe('Machine_Status');
    expect(pickStateTag(['가동상태', 'Temp'])).toBe('가동상태');
    expect(pickStateTag(['Status', 'RunState'])).toBeUndefined();
    expect(pickStateTag(['MotorSpeed'])).toBeUndefined();
  });

  it('값은 다음 값까지, 길어도 유지 시간까지 — 끊긴 곳은 데이터 없음, 같은 상태는 합친다', () => {
    const start = 0;
    const end = 120 * MIN;
    const segments = stateTimeline(
      [
        { at: -2 * MIN, state: 'run' }, // 창 전 값 — 유지 시간 안이라 창 처음을 채운다
        { at: 3 * MIN, state: 'run' },
        { at: 10 * MIN, state: 'stop' },
        { at: 20 * MIN, state: 'alarm' }, // 그 뒤 값이 없다 — 25분부터 끊김
        { at: 60 * MIN, state: undefined }, // 판정 못함
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
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(end - start); // 빈틈 없이 창을 덮는다
  });

  it('값이 하나도 없으면 하루 전체가 데이터 없음이고, 창은 그날 시작 시각부터 24시간이다', () => {
    expect(stateTimeline([], 0, 10, 5)).toEqual([{ from: 0, to: 10, state: 'none' }]);
    const { start, end } = dayWindow(new Date(2026, 9, 14, 3, 0), 8);
    expect(new Date(start).getHours()).toBe(8);
    expect(new Date(start).getDate()).toBe(14);
    expect(end - start).toBe(24 * 3600_000);
  });
});

describe('상태 시간 표기', () => {
  it('1분이 안 되는 시간은 「0분」이 아니라 「1분 미만」', async () => {
    const { duration } = await import('../src/components/collection/DailyStates.js');
    expect(duration(20_000)).toBe('1분 미만');
    expect(duration(90 * 60_000)).toBe('1시간 30분');
    expect(duration(5 * 60_000)).toBe('5분');
  });
});
