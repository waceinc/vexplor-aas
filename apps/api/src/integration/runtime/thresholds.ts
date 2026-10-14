/**
 * Threshold rules with hysteresis (docs/design/integration-v1.md §6.3).
 *
 * `above`: crossed when the value is above `limit` for `raiseSamples` cycles; returned when it is below
 * `limit − hysteresis` for `clearSamples` cycles (`below` mirrored). A value inside the band changes nothing — that is
 * the point of hysteresis: 79 → 81 → 79 → 81 around a limit of 80 with a band of 5 is one crossing, not four.
 * Non-numeric samples are ignored.
 */
import type { ThresholdRule } from '@aas/core';
import { debounceStep, type DebounceTrack } from './alarms.js';

export type ThresholdTrack = DebounceTrack;

export interface ThresholdCycle {
  track: ThresholdTrack;
  crossed?: { since: string };
  returned?: { since: string; returnedAt: string };
}

export function stepThreshold(
  track: ThresholdTrack,
  value: number,
  at: string,
  rule: Pick<ThresholdRule, 'direction' | 'limit' | 'hysteresis' | 'raiseSamples' | 'clearSamples'>,
): ThresholdCycle {
  const beyond = rule.direction === 'above' ? value > rule.limit : value < rule.limit;
  const back = rule.direction === 'above' ? value < rule.limit - rule.hysteresis : value > rule.limit + rule.hysteresis;
  const result = debounceStep(track, beyond, back, at, rule.raiseSamples, rule.clearSamples);
  if (result.change === 'opened') return { track: result.track, crossed: { since: result.streakStart! } };
  if (result.change === 'closed') return { track: result.track, returned: { since: track.since ?? result.streakStart!, returnedAt: result.streakStart! } };
  return { track: result.track };
}
