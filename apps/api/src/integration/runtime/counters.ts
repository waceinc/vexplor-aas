/**
 * Counter arithmetic — shared by the detector (`equipment.counter.advanced`), OEE inputs and CMMS meter readings
 * (docs/design/integration-v1.md §6.3, D13).
 *
 * The one rule behind every branch: **never invent a number.**
 *  - A decrease is a rollover only when the person configured the counter's `max`. Otherwise it is a reset and the delta
 *    is unknown (`null`), not "probably wrapped at 65535".
 *  - A jump faster than `maxRatePerHour` allows is reported as implausible with an unknown delta.
 *  - A long silence before an increase keeps the delta (it is the device's own count) but flags `gap`.
 *
 * Also the sample helpers every runtime module uses, so "which time", "which quality" and "which number" are decided once.
 */
import type { CounterFlags, CounterRule } from '@aas/core';

/** The sample fields the runtime logic reads — store `CollectedValue` and collector `ValueSample` both fit */
export interface RuntimeSample {
  interfaceName: string;
  propertyName: string;
  source?: string;
  observedAt: string;
  receivedAt?: string;
  valueNumber?: number;
  valueText?: string;
  quality?: string;
}

/**
 * The time a sample counts at — the receive time, falling back to the device time for old records.
 * Important: the same basis as the daily state bar (`basis: 'received'`). The device time of a constant tag is frozen,
 *    so judging by it would make segment edges, event times and the bar disagree.
 */
export function sampleTime(sample: Pick<RuntimeSample, 'receivedAt' | 'observedAt'>): string {
  return sample.receivedAt ?? sample.observedAt;
}

export function sampleMs(sample: Pick<RuntimeSample, 'receivedAt' | 'observedAt'>): number {
  return Date.parse(sampleTime(sample));
}

/** Quality absent or starting with "good" (OPC UA `Good`, `GoodLocalOverride`, …) */
export function isGoodQuality(quality: string | undefined): boolean {
  return quality === undefined || quality === '' || /^good/i.test(quality);
}

/** The number a sample holds — the numeric column, else text that parses completely as a finite number */
export function numericValue(sample: Pick<RuntimeSample, 'valueNumber' | 'valueText'>): number | undefined {
  if (sample.valueNumber !== undefined && Number.isFinite(sample.valueNumber)) return sample.valueNumber;
  const text = sample.valueText?.trim();
  if (text === undefined || text === '') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The text a sample holds — what rule words and alarm codes compare against */
export function textValue(sample: Pick<RuntimeSample, 'valueNumber' | 'valueText'>): string | null {
  if (sample.valueText !== undefined && sample.valueText !== '') return sample.valueText;
  if (sample.valueNumber !== undefined) return String(sample.valueNumber);
  return null;
}

/** One good counter reading */
export interface CounterReading {
  value: number;
  /** ISO, `sampleTime` of the sample */
  at: string;
}

export interface CounterStep {
  from: number;
  to: number;
  /** null after a reset without `max`, or when the rate is implausible */
  delta: number | null;
  intervalStart: string;
  intervalEnd: string;
  flags: CounterFlags;
}

const NO_FLAGS: CounterFlags = { reset: false, rollover: false, implausible: false, gap: false };

/**
 * The step from one good reading to the next — undefined when the value did not change (no event, D13).
 * @param freshMs a previous reading older than this before `next` flags `gap` (the server's fresh window)
 */
export function counterStep(
  previous: CounterReading,
  next: CounterReading,
  rule: Pick<CounterRule, 'max' | 'maxRatePerHour'>,
  freshMs: number,
): CounterStep | undefined {
  if (next.value === previous.value) return undefined;
  const flags: CounterFlags = { ...NO_FLAGS };
  let delta: number | null;
  if (next.value > previous.value) {
    delta = next.value - previous.value;
  } else if (rule.max !== null && previous.value <= rule.max && next.value >= 0) {
    // 65530 → 4 with max 65535: 65535 − 65530 + 4 + 1 = 10
    delta = rule.max - previous.value + next.value + 1;
    flags.rollover = true;
  } else {
    delta = null;
    flags.reset = true;
  }
  const elapsedMs = Date.parse(next.at) - Date.parse(previous.at);
  if (delta !== null && rule.maxRatePerHour !== null && delta > (Math.max(0, elapsedMs) / 3_600_000) * rule.maxRatePerHour) {
    delta = null;
    flags.implausible = true;
  }
  if (elapsedMs > freshMs) flags.gap = true;
  return { from: previous.value, to: next.value, delta, intervalStart: previous.at, intervalEnd: next.at, flags };
}

/** Good readings of one property in time order; bad-quality and non-numeric samples are counted, not used */
export function counterReadings(samples: readonly RuntimeSample[]): { readings: CounterReading[]; excludedBadSamples: number } {
  const readings: CounterReading[] = [];
  let excludedBadSamples = 0;
  for (const sample of [...samples].sort((a, b) => sampleMs(a) - sampleMs(b))) {
    const value = numericValue(sample);
    if (!isGoodQuality(sample.quality) || value === undefined) {
      excludedBadSamples += 1;
      continue;
    }
    readings.push({ value, at: sampleTime(sample) });
  }
  return { readings, excludedBadSamples };
}

/** Every step through a reading sequence, starting from `baseline` when there is one */
export function counterSteps(
  readings: readonly CounterReading[],
  rule: Pick<CounterRule, 'max' | 'maxRatePerHour'>,
  freshMs: number,
  baseline?: CounterReading,
): CounterStep[] {
  const steps: CounterStep[] = [];
  let previous = baseline;
  for (const reading of readings) {
    if (previous) {
      const step = counterStep(previous, reading, rule, freshMs);
      if (step) steps.push(step);
    }
    previous = reading;
  }
  return steps;
}

export interface CounterSummary {
  /** Sum of the step deltas — null when any step's delta is unknown (a reset or an implausible jump in between) */
  delta: number | null;
  resets: number;
  flags: CounterFlags;
}

/**
 * Adds steps up. Important: one unknown step makes the total unknown — a sum that silently skips a reset would be a
 *    lower bound presented as the count.
 */
export function summarizeSteps(steps: readonly CounterStep[]): CounterSummary {
  const flags: CounterFlags = { ...NO_FLAGS };
  let delta: number | null = 0;
  let resets = 0;
  for (const step of steps) {
    if (step.flags.reset) resets += 1;
    flags.reset ||= step.flags.reset;
    flags.rollover ||= step.flags.rollover;
    flags.implausible ||= step.flags.implausible;
    flags.gap ||= step.flags.gap;
    delta = delta === null || step.delta === null ? null : delta + step.delta;
  }
  return { delta, resets, flags };
}
