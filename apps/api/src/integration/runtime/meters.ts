/**
 * CMMS meter readings — pulled daily (or per shift / hour) and deduplicated on `readingId` (docs/design/integration-v1.md
 * §4.6, §6.4, D20).
 *
 * Two meter kinds:
 *  - `deviceCounter`: a configured counter. One reading per period = the last good value in the period; `delta` = the sum
 *    of the counter steps ending in the period (null when a reset or implausible jump makes it unknown), with the flags
 *    of those steps.
 *  - `computedRunTime` (`counter=runtime`): running seconds per period from the state segments. Only finished periods
 *    are reported — a reading of an unfinished period would change after the CMMS booked it.
 */
import type { AidInterface } from '@aas/collector';
import type { CounterFlags, CounterRule, Environment, StateRules } from '@aas/core';
import type { AasStore, CollectedValue } from '@aas/store';
import { readingIdFor } from '../ids.js';
import { counterStep, isGoodQuality, numericValue, sampleMs, summarizeSteps, type CounterReading, type CounterStep } from './counters.js';
import { elementSourceFor, isVirtualPlc } from './element-ref.js';
import { computeSegments, readWindow } from './segments.js';
import type { Period } from './zoned.js';

export type MeterFlags = CounterFlags & { simulated: boolean };

export interface MeterReading {
  readingId: string;
  assetId: string;
  meterId: string;
  meterKind: 'deviceCounter' | 'computedRunTime';
  unit: string | null;
  reading: number;
  delta: number | null;
  periodStart: string;
  periodEnd: string;
  observedAt: string;
  receivedAt: string | null;
  flags: MeterFlags;
  excludedBadSamples: number;
  source: ReturnType<typeof elementSourceFor>;
  /** Where the raw values behind this reading can be read back */
  evidence: string;
  runningSeconds?: number;
  stoppedSeconds?: number;
  alarmSeconds?: number;
  offSeconds?: number;
  unknownSeconds?: number;
}

export interface MeterContext {
  store: Pick<AasStore, 'readValues'>;
  packageId: string;
  /** globalAssetId of the package's first AAS, else the package id */
  assetId: string;
  environment: Environment;
  interfaces: readonly AidInterface[];
  holdMs: number;
  now: number;
}

function evidenceUrl(packageId: string, property: string, from: number, to: number): string {
  const query = new URLSearchParams({ property, from: new Date(from).toISOString(), to: new Date(to).toISOString(), basis: 'received' });
  return `/packages/${encodeURIComponent(packageId)}/values?${query.toString()}`;
}

function interfaceOf(context: MeterContext, interfaceName: string | undefined, property: string): AidInterface | undefined {
  return (
    context.interfaces.find((candidate) => candidate.name === interfaceName) ??
    context.interfaces.find((candidate) => candidate.properties.some((p) => p.name === property))
  );
}

/** Device counter readings, one per period that holds at least one good value */
export async function deviceCounterReadings(context: MeterContext, rule: CounterRule, periods: readonly Period[]): Promise<{ readings: MeterReading[]; truncated: boolean }> {
  if (periods.length === 0) return { readings: [], truncated: false };
  const first = periods[0]!.start;
  const last = periods[periods.length - 1]!.end;
  const { values, truncated } = await readWindow(context.store, context.packageId, { propertyName: rule.property }, new Date(first - context.holdMs).toISOString(), new Date(last).toISOString());

  // Good readings with their samples, and bad ones counted per period
  const good: { reading: CounterReading; sample: CollectedValue }[] = [];
  const bad: number[] = [];
  for (const sample of values) {
    const value = numericValue(sample);
    if (!isGoodQuality(sample.quality) || value === undefined) bad.push(sampleMs(sample));
    else good.push({ reading: { value, at: sample.receivedAt ?? sample.observedAt }, sample });
  }
  const steps: CounterStep[] = [];
  for (let i = 1; i < good.length; i++) {
    const step = counterStep(good[i - 1]!.reading, good[i]!.reading, rule, context.holdMs);
    if (step) steps.push(step);
  }

  const out: MeterReading[] = [];
  for (const period of periods) {
    const inPeriod = good.filter((entry) => {
      const at = Date.parse(entry.reading.at);
      return at >= period.start && at < period.end;
    });
    const lastEntry = inPeriod[inPeriod.length - 1];
    if (!lastEntry) continue;
    const periodSteps = steps.filter((step) => {
      const at = Date.parse(step.intervalEnd);
      return at >= period.start && at < period.end;
    });
    // The delta is measured against the previous period's last good value (D20); without one it is unknown — the
    // count before the first reading of the period is not known, so the steps inside it are not the period's change
    const hasPrevious = good.some((entry) => Date.parse(entry.reading.at) < period.start);
    const summary = summarizeSteps(periodSteps);
    const iface = interfaceOf(context, lastEntry.sample.interfaceName, rule.property);
    const simulated = iface ? isVirtualPlc(iface) : false;
    out.push({
      readingId: readingIdFor(context.assetId, rule.id, lastEntry.sample.observedAt),
      assetId: context.assetId,
      meterId: rule.id,
      meterKind: 'deviceCounter',
      unit: rule.unit,
      reading: lastEntry.reading.value,
      // No earlier good value at all: the change over the period is unknown, not zero
      delta: hasPrevious ? summary.delta : null,
      periodStart: new Date(period.start).toISOString(),
      periodEnd: new Date(period.end).toISOString(),
      observedAt: lastEntry.sample.observedAt,
      receivedAt: lastEntry.sample.receivedAt ?? null,
      flags: { ...summary.flags, simulated },
      excludedBadSamples: bad.filter((at) => at >= period.start && at < period.end).length,
      source: elementSourceFor(context.environment, iface, lastEntry.sample.interfaceName, rule.property, lastEntry.sample.source, simulated),
      evidence: evidenceUrl(context.packageId, rule.property, period.start, period.end),
    });
  }
  return { readings: out, truncated };
}

/** Running time per finished period from the state segments */
export async function runTimeReadings(
  context: MeterContext,
  state: { property: string; interfaceName: string | null },
  rules: StateRules,
  periods: readonly Period[],
): Promise<{ readings: MeterReading[]; truncated: boolean }> {
  const out: MeterReading[] = [];
  let truncated = false;
  const iface = interfaceOf(context, state.interfaceName ?? undefined, state.property);
  const simulated = iface ? isVirtualPlc(iface) : false;
  for (const period of periods) {
    if (period.end > context.now) continue;
    const result = await computeSegments(context.store, context.packageId, state, rules, period.start, period.end, context.holdMs);
    truncated ||= result.truncated;
    const seconds = (ms: number): number => Math.round(ms / 10) / 100;
    const periodEnd = new Date(period.end).toISOString();
    const running = seconds(result.totals.run);
    out.push({
      readingId: readingIdFor(context.assetId, 'runtime', periodEnd),
      assetId: context.assetId,
      meterId: 'runtime',
      meterKind: 'computedRunTime',
      unit: 's',
      reading: running,
      delta: running,
      periodStart: new Date(period.start).toISOString(),
      periodEnd,
      observedAt: periodEnd,
      receivedAt: null,
      // gap = part of the period had no data: the running time is a lower bound for that period
      flags: { reset: false, rollover: false, implausible: false, gap: result.totals.none > 0, simulated },
      excludedBadSamples: 0,
      source: elementSourceFor(context.environment, iface, iface?.name ?? state.interfaceName ?? '', state.property, undefined, simulated),
      evidence: evidenceUrl(context.packageId, state.property, period.start, period.end),
      runningSeconds: running,
      stoppedSeconds: seconds(result.totals.stop),
      alarmSeconds: seconds(result.totals.alarm),
      offSeconds: seconds(result.totals.off),
      unknownSeconds: seconds(result.totals.unknown),
    });
  }
  return { readings: out, truncated };
}
