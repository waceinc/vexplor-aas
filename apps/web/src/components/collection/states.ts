/**
 * 설비 상태 — 수집값에서 가동 · 정지 · 알람 · 전원 꺼짐을 읽고, 하루 막대(간트)의 구간으로 만든다(화면 없음).
 *
 * digital-twin 의 상태 추출(요소 이름으로 상태 태그를 찾고 값을 정규화)과 하루 간트(08시 시작 24시간) 개념을 옮겼다.
 * 이름 추측은 고객마다 틀릴 수 있어 판정 규칙을 밖에서 바꿀 수 있게 했고(StateRules),
 * 규칙에 없는 값은 지어내지 않고 「판정 못함」으로 둔다. 값이 끊긴 구간은 「데이터 없음」이다.
 */
import type { CollectedValueView } from '../../api.js';

export type MachineState = 'run' | 'stop' | 'alarm' | 'off';
export type BarState = MachineState | 'unknown' | 'none';

/** 상태마다 그 값으로 볼 글자 — 대소문자 · 공백은 무시한다 */
export type StateRules = Record<MachineState, readonly string[]>;

export const DEFAULT_STATE_RULES: StateRules = {
  run: ['가동', '운전', '정상', '생산', 'run', 'running', 'auto', 'production', 'on', 'true', '1'], // i18n-ignore — 화면 글자가 아니라 장비 값과 맞춰 보는 자료
  stop: ['정지', '대기', 'stop', 'stopped', 'idle', 'standby', 'hold', 'off', 'false', '0'], // i18n-ignore — 화면 글자가 아니라 장비 값과 맞춰 보는 자료
  alarm: ['알람', '이상', '고장', '비상', 'alarm', 'fault', 'error', 'trip', 'emergency'], // i18n-ignore — 화면 글자가 아니라 장비 값과 맞춰 보는 자료
  off: ['전원꺼짐', '전원off', 'poweroff', 'shutdown'], // i18n-ignore — 화면 글자가 아니라 장비 값과 맞춰 보는 자료
};

const norm = (text: string): string => text.toLowerCase().replace(/[\s_\-]/g, '');

/** 값 하나를 상태로 — 규칙에 없으면 undefined(판정 못함) */
export function normalizeState(value: Pick<CollectedValueView, 'valueText' | 'valueNumber'>, rules: StateRules = DEFAULT_STATE_RULES): MachineState | undefined {
  const raw = value.valueText !== undefined && value.valueText !== '' ? value.valueText : value.valueNumber !== undefined ? String(value.valueNumber) : '';
  const key = norm(raw);
  if (!key) return undefined;
  for (const state of ['alarm', 'off', 'run', 'stop'] as const) {
    if (rules[state].some((word) => norm(word) === key)) return state;
  }
  return undefined;
}

/** 상태 태그를 이름으로 고른다 — 하나만 맞을 때만(둘 이상이면 사람이 고른다) */
const STATE_TAG = /^(status|state|machinestatus|machinestate|operatingstate|operationstate|operatingstatus|runstate|runstatus|equipmentstatus|가동상태|운전상태|설비상태|상태)$/;
export function pickStateTag(names: readonly string[]): string | undefined {
  const hits = names.filter((name) => STATE_TAG.test(norm(name)));
  return hits.length === 1 ? hits[0] : undefined;
}

export interface Segment {
  from: number;
  to: number;
  state: BarState;
}

/**
 * 하루 구간 — 값 하나는 다음 값까지, 길어도 holdMs 까지만 이어진다(그 뒤는 데이터 없음).
 * 창 시작 전 마지막 값도 holdMs 안이면 창 처음을 채운다. 같은 상태가 이어지면 하나로 합친다.
 */
export function stateTimeline(
  samples: readonly { at: number; state: MachineState | undefined }[],
  start: number,
  end: number,
  holdMs: number,
): Segment[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const raw: Segment[] = [];
  let cursor = start;
  const push = (from: number, to: number, state: BarState): void => {
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b <= a) return;
    if (a > cursor) raw.push({ from: cursor, to: a, state: 'none' });
    raw.push({ from: a, to: b, state });
    cursor = Math.max(cursor, b);
  };
  sorted.forEach((sample, index) => {
    const next = sorted[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    push(sample.at, Math.min(next, sample.at + holdMs), sample.state ?? 'unknown');
  });
  if (cursor < end) raw.push({ from: cursor, to: end, state: 'none' });
  const merged: Segment[] = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    if (last && last.state === segment.state && last.to === segment.from) last.to = segment.to;
    else merged.push({ ...segment });
  }
  return merged;
}

/** 상태별 합계(ms) */
export function stateTotals(segments: readonly Segment[]): Record<BarState, number> {
  const totals: Record<BarState, number> = { run: 0, stop: 0, alarm: 0, off: 0, unknown: 0, none: 0 };
  for (const segment of segments) totals[segment.state] += segment.to - segment.from;
  return totals;
}

/** 그날의 창 — startHour 시 시작 24시간(교대 기준). day 는 그 창이 시작하는 날짜(로컬) */
export function dayWindow(day: Date, startHour: number): { start: number; end: number } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, 0, 0, 0).getTime();
  return { start, end: start + 24 * 3600_000 };
}

/** 규칙 글 ↔ 목록 — 화면에서 쉼표로 고친다 */
export function parseRuleList(text: string): string[] {
  return text.split(',').map((word) => word.trim()).filter((word) => word !== '');
}
