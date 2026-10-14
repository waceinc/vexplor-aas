/**
 * Threshold rules with hysteresis (docs/design/integration-v1.md §6.3).
 *
 * `above`: crossed when the value is above `limit` for `raiseSamples` cycles; returned when it is below
 * `limit − hysteresis` for `clearSamples` cycles (`below` mirrored). A value inside the band changes nothing — that is
 * the point of hysteresis: 79 → 81 → 79 → 81 around a limit of 80 with a band of 5 is one crossing, not four.
 * Non-numeric samples are ignored.
 */
import { EVENT_TYPES, type EquipmentThresholdData, type ThresholdRule } from '@aas/core';
import { numericValue, sampleTime } from './counters.js';
import { latestGood, type DetectContext } from './detector-state.js';
import { debounceStep, type DebounceTrack } from './alarms.js';

export interface ThresholdTrack extends DebounceTrack {
  /** Kept while open, so the crossing can still be closed with its details when its rule is removed */
  rule?: Pick<ThresholdRule, 'property' | 'direction' | 'limit' | 'hysteresis' | 'unit' | 'severity'>;
  /** Last numeric value seen while open */
  last?: { value: number; observedAt: string };
}

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

/** Threshold events of one cycle */
export function detectThresholds(ctx: DetectContext): void {
  const { config, state, cycle, asset, suppressed, push, sourceOf } = ctx;
  for (const rule of config.thresholds) {
    const sample = latestGood(cycle.samples, rule.property);
    const value = sample ? numericValue(sample) : undefined;
    if (!sample || value === undefined) continue;
    const at = sampleTime(sample);
    const result = stepThreshold(state.thresholds[rule.id] ?? { open: false, pendingCount: 0 }, value, at, rule);
    const { direction, limit, hysteresis, unit, severity, property } = rule;
    state.thresholds[rule.id] = result.track.open
      ? { ...result.track, rule: { direction, limit, hysteresis, unit, severity, property }, last: { value, observedAt: sample.observedAt } }
      : result.track;
    const data = (): EquipmentThresholdData => ({
      asset,
      source: sourceOf(sample),
      thresholdId: rule.id,
      direction: rule.direction,
      limit: rule.limit,
      hysteresis: rule.hysteresis,
      value,
      unit: rule.unit,
      severity: rule.severity,
      observedAt: sample.observedAt,
      detectedAt: at,
      suppressed,
    });
    if (result.crossed) push(EVENT_TYPES.equipmentThresholdCrossed, rule.id, result.crossed.since, 'crossed', data());
    if (result.returned) push(EVENT_TYPES.equipmentThresholdReturned, rule.id, result.returned.returnedAt, 'returned', data());
  }
}
