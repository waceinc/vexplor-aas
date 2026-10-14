/**
 * OEE inputs — the durations and counts an MES needs to compute OEE, never an OEE number (docs/design/integration-v1.md
 * §4.6, §6.4). Planned production time, ideal cycle time and quality rules live in the MES; a number computed here
 * without them would be presented as a fact it is not.
 */
import type { CounterKind, CounterRule, PackageIntegrationConfig, StateRules } from '@aas/core';
import type { AasStore } from '@aas/store';
import { counterReadings, counterSteps, summarizeSteps, type CounterReading } from './counters.js';
import { computeSegments, readWindow, ruleSetHash } from './segments.js';

export interface CounterTotal {
  delta: number | null;
  resets: number;
  counterId: string;
}

export interface OeeInputs {
  window: { from: string; to: string; timezone: string };
  runMs: number;
  stopMs: number;
  alarmMs: number;
  offMs: number;
  unknownMs: number;
  noDataMs: number;
  /** Share of the window with data, 0..1 */
  coverage: number;
  /** The collection interval — how coarse the edges are; null when the server does not collect automatically */
  resolutionMs: number | null;
  produced: CounterTotal | null;
  good: CounterTotal | null;
  reject: CounterTotal | null;
  ruleSetHash: string;
  /** More stored values than one read may hold — the totals cover only the newest part */
  truncated?: true;
}

/**
 * Counter delta over [start, end): steps whose end falls in the window, starting from the last good reading before it
 * (within `holdMs`). A step is attributed to the window its later reading falls in — the same as the
 * `equipment.counter.advanced` events grouped by `intervalEnd`.
 */
export async function counterTotal(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  rule: CounterRule,
  start: number,
  end: number,
  holdMs: number,
): Promise<{ total: CounterTotal; truncated: boolean }> {
  const { values, truncated } = await readWindow(store, packageId, { propertyName: rule.property }, new Date(start - holdMs).toISOString(), new Date(end).toISOString());
  const { readings } = counterReadings(values);
  const before = readings.filter((reading) => Date.parse(reading.at) < start);
  const inside = readings.filter((reading) => Date.parse(reading.at) >= start);
  const baseline: CounterReading | undefined = before[before.length - 1];
  const summary = summarizeSteps(counterSteps(inside, rule, holdMs, baseline));
  // No good reading in the window: the change is unknown — an empty sum is not a measured zero
  const delta = inside.length === 0 ? null : summary.delta;
  return { total: { delta, resets: summary.resets, counterId: rule.id }, truncated };
}

const KIND_SLOTS: readonly [keyof Pick<OeeInputs, 'produced' | 'good' | 'reject'>, CounterKind][] = [
  ['produced', 'total'],
  ['good', 'good'],
  ['reject', 'reject'],
];

export async function computeOeeInputs(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  config: PackageIntegrationConfig,
  rules: StateRules,
  window: { start: number; end: number; timezone: string },
  holdMs: number,
  resolutionMs: number | null,
): Promise<OeeInputs> {
  const state = config.state!;
  const { totals, truncated } = await computeSegments(store, packageId, state, rules, window.start, window.end, holdMs);
  const windowMs = window.end - window.start;
  const result: OeeInputs = {
    window: { from: new Date(window.start).toISOString(), to: new Date(window.end).toISOString(), timezone: window.timezone },
    runMs: totals.run,
    stopMs: totals.stop,
    alarmMs: totals.alarm,
    offMs: totals.off,
    unknownMs: totals.unknown,
    noDataMs: totals.none,
    coverage: windowMs > 0 ? Math.round((1 - totals.none / windowMs) * 10_000) / 10_000 : 0,
    resolutionMs,
    produced: null,
    good: null,
    reject: null,
    ruleSetHash: ruleSetHash(rules),
  };
  let anyTruncated = truncated;
  for (const [slot, kind] of KIND_SLOTS) {
    // The first counter of a kind — a second one of the same kind is a configuration choice the MES does not see here
    const rule = config.counters.find((counter) => counter.kind === kind);
    if (!rule) continue;
    const { total, truncated: cut } = await counterTotal(store, packageId, rule, window.start, window.end, holdMs);
    result[slot] = total;
    anyTruncated ||= cut;
  }
  if (anyTruncated) result.truncated = true;
  return result;
}
