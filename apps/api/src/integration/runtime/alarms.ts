/**
 * Alarm rules — raise and clear with a debounce (docs/design/integration-v1.md §6.3, D14).
 *
 * Alarm events come **only** from configured alarm rules. A state that reads `alarm` gives `equipment.state.changed`
 * and nothing else — guessing an alarm's identity from a state word would invent alarms nobody configured.
 *
 * The debounce is shared with thresholds: a condition must hold for `raiseSamples` consecutive cycles to open and its
 * opposite for `clearSamples` consecutive cycles to close. A cycle without a good sample of the property is no evidence
 * either way and leaves the counts as they are.
 */
import type { AlarmActiveWhen, AlarmRule } from '@aas/core';
import { numericValue, textValue, type RuntimeSample } from './counters.js';

/** Debounce state of one rule — persisted inside the detector state */
export interface DebounceTrack {
  open: boolean;
  /** Time the open condition (or the close condition while open) was first seen in the current streak */
  firstAt?: string;
  pendingCount: number;
  /** When it opened — the first qualifying sample time of the raising streak */
  since?: string;
}

export interface DebounceResult {
  track: DebounceTrack;
  /** 'opened' / 'closed' when this cycle confirmed a transition; 'reopened' when it went back before a close was confirmed */
  change?: 'opened' | 'closed' | 'reopened';
  /** First sample time of the confirming streak (raisedAt / clearedAt) */
  streakStart?: string;
}

/**
 * One cycle of a debounced condition.
 * @param wantsOpen the open condition holds in this cycle (alarm active, value beyond the limit)
 * @param wantsClose the close condition holds (alarm inactive, value back inside limit − hysteresis); for thresholds both
 *    can be false (inside the hysteresis band) — that breaks any streak without changing the state
 */
export function debounceStep(
  track: DebounceTrack,
  wantsOpen: boolean,
  wantsClose: boolean,
  at: string,
  raiseSamples: number,
  clearSamples: number,
): DebounceResult {
  if (!track.open) {
    if (!wantsOpen) return { track: { open: false, pendingCount: 0 } };
    const firstAt = track.pendingCount > 0 && track.firstAt !== undefined ? track.firstAt : at;
    const pendingCount = track.pendingCount + 1;
    if (pendingCount >= raiseSamples) return { track: { open: true, pendingCount: 0, since: firstAt }, change: 'opened', streakStart: firstAt };
    return { track: { open: false, pendingCount, firstAt } };
  }
  if (wantsClose) {
    const firstAt = track.pendingCount > 0 && track.firstAt !== undefined ? track.firstAt : at;
    const pendingCount = track.pendingCount + 1;
    if (pendingCount >= clearSamples) return { track: { open: false, pendingCount: 0 }, change: 'closed', streakStart: firstAt };
    return { track: { ...track, pendingCount, firstAt } };
  }
  // Open and the close streak (if any) broke: a re-raise while still open
  const reopened = track.pendingCount > 0 && wantsOpen;
  const next: DebounceTrack = { open: true, pendingCount: 0, ...(track.since === undefined ? {} : { since: track.since }) };
  return reopened ? { track: next, change: 'reopened' } : { track: next };
}

/**
 * Whether an alarm sample reads as active.
 * `truthy`: true / 1 / any non-zero number / "true" (case-insensitive). `equals`: the text equals one of the listed
 * values (trimmed, case-sensitive — alarm codes are), or both are numbers and equal ("3" equals "3.0").
 */
export function isAlarmActive(sample: Pick<RuntimeSample, 'valueNumber' | 'valueText'>, activeWhen: AlarmActiveWhen): boolean {
  if (activeWhen === 'truthy') {
    const number = numericValue(sample);
    if (number !== undefined) return number !== 0;
    return (textValue(sample) ?? '').trim().toLowerCase() === 'true';
  }
  const text = (textValue(sample) ?? '').trim();
  const number = numericValue(sample);
  return activeWhen.equals.some((wanted) => {
    const candidate = wanted.trim();
    if (candidate === text) return true;
    const parsed = Number(candidate);
    return number !== undefined && candidate !== '' && Number.isFinite(parsed) && parsed === number;
  });
}

/** Persisted state of one alarm rule */
export interface AlarmTrack extends DebounceTrack {
  instanceId?: string;
  occurrences: number;
  code?: string | null;
  text?: string | null;
}

export interface AlarmCycle {
  track: AlarmTrack;
  raised?: { raisedAt: string; instanceId: string };
  cleared?: { raisedAt: string; clearedAt: string; instanceId: string; occurrences: number; code: string | null; text: string | null };
}

/**
 * One cycle of an alarm rule.
 * @param instanceIdFor deterministic id from the raise time (`alarmInstanceIdFor(globalAssetId, ruleId, raisedAt)`)
 * @param details code / text read from the rule's code and text properties in this cycle (kept from the raise)
 */
export function stepAlarm(
  track: AlarmTrack,
  active: boolean,
  at: string,
  rule: Pick<AlarmRule, 'raiseSamples' | 'clearSamples'>,
  instanceIdFor: (raisedAt: string) => string,
  details: { code: string | null; text: string | null },
): AlarmCycle {
  const result = debounceStep(track, active, !active, at, rule.raiseSamples, rule.clearSamples);
  if (result.change === 'opened') {
    const raisedAt = result.streakStart!;
    const instanceId = instanceIdFor(raisedAt);
    return {
      track: { ...result.track, instanceId, occurrences: 1, code: details.code, text: details.text },
      raised: { raisedAt, instanceId },
    };
  }
  if (result.change === 'closed') {
    return {
      track: { ...result.track, occurrences: 0 },
      cleared: {
        raisedAt: track.since ?? result.streakStart!,
        clearedAt: result.streakStart!,
        instanceId: track.instanceId ?? instanceIdFor(track.since ?? result.streakStart!),
        occurrences: track.occurrences,
        code: track.code ?? null,
        text: track.text ?? null,
      },
    };
  }
  const occurrences = track.occurrences + (result.change === 'reopened' ? 1 : 0);
  const kept: AlarmTrack = { ...result.track, occurrences };
  if (result.track.open) {
    if (track.instanceId !== undefined) kept.instanceId = track.instanceId;
    kept.code = track.code ?? null;
    kept.text = track.text ?? null;
  }
  return { track: kept };
}
