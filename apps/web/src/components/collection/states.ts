/**
 * Equipment state — reads running · stopped · alarm · power off from collected values and turns them into segments of a daily bar (Gantt) (no UI).
 *
 * Ports digital-twin's state extraction (find the state tag by element name and normalize its value) and the daily Gantt (24 hours from 08:00).
 * Name guessing can be wrong per customer, so the matching rules can be changed from outside (StateRules);
 * values not in the rules are not invented but left as "undetermined". Spans where values stop are "no data".
 */
import type { CollectedValueView } from '../../api.js';

export type MachineState = 'run' | 'stop' | 'alarm' | 'off';
export type BarState = MachineState | 'unknown' | 'none';

/** Strings to read as each state — case and whitespace are ignored */
export type StateRules = Record<MachineState, readonly string[]>;

export const DEFAULT_STATE_RULES: StateRules = {
  run: ['가동', '운전', '정상', '생산', 'run', 'running', 'auto', 'production', 'on', 'true', '1'], // i18n-ignore — not screen text; data matched against equipment values
  stop: ['정지', '대기', 'stop', 'stopped', 'idle', 'standby', 'hold', 'off', 'false', '0'], // i18n-ignore — not screen text; data matched against equipment values
  alarm: ['알람', '이상', '고장', '비상', 'alarm', 'fault', 'error', 'trip', 'emergency'], // i18n-ignore — not screen text; data matched against equipment values
  off: ['전원꺼짐', '전원off', 'poweroff', 'shutdown'], // i18n-ignore — not screen text; data matched against equipment values
};

const norm = (text: string): string => text.toLowerCase().replace(/[\s_\-]/g, '');

/** One value to a state — undefined (undetermined) when not in the rules */
export function normalizeState(value: Pick<CollectedValueView, 'valueText' | 'valueNumber'>, rules: StateRules = DEFAULT_STATE_RULES): MachineState | undefined {
  const raw = value.valueText !== undefined && value.valueText !== '' ? value.valueText : value.valueNumber !== undefined ? String(value.valueNumber) : '';
  const key = norm(raw);
  if (!key) return undefined;
  for (const state of ['alarm', 'off', 'run', 'stop'] as const) {
    if (rules[state].some((word) => norm(word) === key)) return state;
  }
  return undefined;
}

/** Picks the state tag by name — only when exactly one matches (two or more: a person picks) */
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
 * Daily segments — one value lasts until the next value, but at most holdMs (after that, no data).
 * The last value before the window start also fills the start of the window if within holdMs. Consecutive equal states merge into one.
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

/** Total per state (ms) */
export function stateTotals(segments: readonly Segment[]): Record<BarState, number> {
  const totals: Record<BarState, number> = { run: 0, stop: 0, alarm: 0, off: 0, unknown: 0, none: 0 };
  for (const segment of segments) totals[segment.state] += segment.to - segment.from;
  return totals;
}

/** The day's window — 24 hours from startHour (shift basis). day is the (local) date the window starts on */
export function dayWindow(day: Date, startHour: number): { start: number; end: number } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, 0, 0, 0).getTime();
  return { start, end: start + 24 * 3600_000 };
}

/** Rule text ↔ list — edited on screen with commas */
export function parseRuleList(text: string): string[] {
  return text.split(',').map((word) => word.trim()).filter((word) => word !== '');
}
