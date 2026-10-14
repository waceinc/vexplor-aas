/**
 * Equipment state — reads running · stopped · alarm · power off from collected values and turns them into segments
 * of a daily bar (Gantt). Pure functions, shared by the server (event detector, segments, OEE inputs) and the web UI.
 *
 * Why here and not in the web app: two screens with two rule sets give two answers, and events need one judge.
 * The UI bar and the server detector call the same functions with the same rules on the same stored values,
 * so the bar and the events agree (docs/design/integration-v1.md §6, D3).
 *
 * Name guessing can be wrong per customer, so the matching rules can be changed from outside (StateRules);
 * values not in the rules are not invented but left as "undetermined". Spans where values stop are "no data".
 *
 * Important: browser-safe — no `node:` imports. The web bundle loads this file.
 */

export type MachineState = 'run' | 'stop' | 'alarm' | 'off';
/** What the detector stores — a value outside the rules is `unknown`, never mapped to stop */
export type MachineStateOrUnknown = MachineState | 'unknown';
export type BarState = MachineState | 'unknown' | 'none';

export const MACHINE_STATES: readonly MachineState[] = ['run', 'stop', 'alarm', 'off'];

/** Strings to read as each state — case, whitespace, `_` and `-` are ignored */
export type StateRules = Record<MachineState, readonly string[]>;

export const DEFAULT_STATE_RULES: StateRules = {
  run: ['가동', '운전', '정상', '생산', 'run', 'running', 'auto', 'production', 'on', 'true', '1'], // i18n-ignore — not screen text; data matched against equipment values
  stop: ['정지', '대기', 'stop', 'stopped', 'idle', 'standby', 'hold', 'off', 'false', '0'], // i18n-ignore — not screen text; data matched against equipment values
  alarm: ['알람', '이상', '고장', '비상', 'alarm', 'fault', 'error', 'trip', 'emergency'], // i18n-ignore — not screen text; data matched against equipment values
  off: ['전원꺼짐', '전원off', 'poweroff', 'shutdown'], // i18n-ignore — not screen text; data matched against equipment values
};

/** The shape of one collected value this module needs — the web view and the store sample both fit it */
export interface StateValue {
  valueText?: string;
  valueNumber?: number;
}

/** Normalisation used for every rule comparison. Exported so the config validator and the hash input agree with it */
export const normalizeStateWord = (text: string): string => text.toLowerCase().replace(/[\s_\-]/g, '');

/** The order rules are tried in. Important: alarm and off first — a word listed twice must resolve the same everywhere */
export const STATE_MATCH_ORDER: readonly MachineState[] = ['alarm', 'off', 'run', 'stop'];

/** One value to a state — undefined (undetermined) when not in the rules */
export function normalizeState(value: StateValue, rules: StateRules = DEFAULT_STATE_RULES): MachineState | undefined {
  const raw = value.valueText !== undefined && value.valueText !== '' ? value.valueText : value.valueNumber !== undefined ? String(value.valueNumber) : '';
  const key = normalizeStateWord(raw);
  if (!key) return undefined;
  for (const state of STATE_MATCH_ORDER) {
    if (rules[state].some((word) => normalizeStateWord(word) === key)) return state;
  }
  return undefined;
}

/** Picks the state tag by name — only when exactly one matches (two or more: a person picks) */
const STATE_TAG = /^(status|state|machinestatus|machinestate|operatingstate|operationstate|operatingstatus|runstate|runstatus|equipmentstatus|가동상태|운전상태|설비상태|상태)$/;
export function pickStateTag(names: readonly string[]): string | undefined {
  const hits = names.filter((name) => STATE_TAG.test(normalizeStateWord(name)));
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

/**
 * The day's window — 24 hours from startHour (shift basis). day is the (local) date the window starts on.
 * Important: uses the runtime's local time zone. The server computes windows in the configured time zone instead
 * (apps/api/src/integration/runtime/zoned.ts); this function stays for the browser, where local time is the user's.
 */
export function dayWindow(day: Date, startHour: number): { start: number; end: number } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, 0, 0, 0).getTime();
  return { start, end: start + 24 * 3600_000 };
}

/** Rule text ↔ list — edited on screen with commas */
export function parseRuleList(text: string): string[] {
  return text.split(',').map((word) => word.trim()).filter((word) => word !== '');
}

/** Default freshness window — values that arrived within it are receiving */
export const FRESH_WINDOW_MS = 5 * 60_000;

/**
 * Decides the freshness window from the automatic collection interval — the larger of 3x the interval and 5 minutes.
 * The server uses the same window as the hold time of state segments and as the counter gap limit.
 */
export function freshWindowMs(intervalMs: number | undefined): number {
  return Math.max(FRESH_WINDOW_MS, 3 * (intervalMs ?? 0));
}
