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
import { counterStep, isGoodQuality, numericValue, sampleMs, sampleTime, summarizeSteps, type CounterReading, type CounterStep } from './counters.js';
import { elementSourceFor, isVirtualPlc } from './element-ref.js';
import { lowerBound, readStateSamples, readWindow, segmentsOf } from './segments.js';
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

/** Device counter readings, one per period that holds at least one good value. One read, one sorted pass */
export async function deviceCounterReadings(context: MeterContext, rule: CounterRule, periods: readonly Period[]): Promise<MeterReading[]> {
  if (periods.length === 0) return [];
  const first = periods[0]!.start;
  const last = periods[periods.length - 1]!.end;
  const values = await readWindow(context.store, context.packageId, { propertyName: rule.property }, new Date(first - context.holdMs).toISOString(), new Date(last).toISOString());

  // Good readings with their samples (oldest first), and the times of bad ones
  const good: { at: number; reading: CounterReading; sample: CollectedValue }[] = [];
  const bad: { at: number }[] = [];
  for (const sample of values) {
    const value = numericValue(sample);
    const at = sampleMs(sample);
    if (!isGoodQuality(sample.quality) || value === undefined) bad.push({ at });
    else good.push({ at, reading: { value, at: sampleTime(sample) }, sample });
  }
  // steps[i] ends at good[i + 1]; a step whose value did not change is null
  const steps: (CounterStep | undefined)[] = [];
  for (let i = 1; i < good.length; i++) steps.push(counterStep(good[i - 1]!.reading, good[i]!.reading, rule, context.holdMs));

  const out: MeterReading[] = [];
  for (const period of periods) {
    const lo = lowerBound(good, period.start);
    const hi = lowerBound(good, period.end);
    if (hi <= lo) continue;
    const lastEntry = good[hi - 1]!;
    // Steps ending inside the period: the one from the previous reading into it, then those between its readings
    const periodSteps = steps.slice(Math.max(0, lo - 1), hi - 1).filter((step): step is CounterStep => step !== undefined);
    // The delta is measured against the previous period's last good value (D20); without one it is unknown — the
    // count before the first reading of the period is not known, so the steps inside it are not the period's change
    const hasPrevious = lo > 0;
    const summary = summarizeSteps(periodSteps);
    const iface = interfaceOf(context, lastEntry.sample.interfaceName, rule.property);
    const simulated = iface ? isVirtualPlc(iface) : false;
    out.push({
      // Important: keyed by the receive time (review M5). The device time of an idle counter stays frozen, so keying by
      //    it would give the readings of several periods one id and the CMMS would drop all but the first
      readingId: readingIdFor(context.assetId, rule.id, lastEntry.reading.at),
      assetId: context.assetId,
      meterId: rule.id,
      meterKind: 'deviceCounter',
      unit: rule.unit,
      reading: lastEntry.reading.value,
      delta: hasPrevious ? summary.delta : null,
      periodStart: new Date(period.start).toISOString(),
      periodEnd: new Date(period.end).toISOString(),
      observedAt: lastEntry.sample.observedAt,
      receivedAt: lastEntry.sample.receivedAt ?? null,
      flags: { ...summary.flags, simulated },
      excludedBadSamples: lowerBound(bad, period.end) - lowerBound(bad, period.start),
      source: elementSourceFor(context.environment, iface, lastEntry.sample.interfaceName, rule.property, lastEntry.sample.source, simulated),
      evidence: evidenceUrl(context.packageId, rule.property, period.start, period.end),
    });
  }
  return out;
}

/** Running time per finished period from the state segments. One read for all periods */
export async function runTimeReadings(
  context: MeterContext,
  state: { property: string; interfaceName: string | null },
  rules: StateRules,
  periods: readonly Period[],
): Promise<MeterReading[]> {
  const finished = periods.filter((period) => period.end <= context.now);
  if (finished.length === 0) return [];
  const iface = interfaceOf(context, state.interfaceName ?? undefined, state.property);
  const simulated = iface ? isVirtualPlc(iface) : false;
  const samples = await readStateSamples(context.store, context.packageId, state, rules, finished[0]!.start, finished[finished.length - 1]!.end, context.holdMs);
  const seconds = (ms: number): number => Math.round(ms / 10) / 100;
  return finished.map((period) => {
    const { totals } = segmentsOf(samples, period.start, period.end, context.holdMs);
    const periodEnd = new Date(period.end).toISOString();
    const running = seconds(totals.run);
    return {
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
      flags: { reset: false, rollover: false, implausible: false, gap: totals.none > 0, simulated },
      excludedBadSamples: 0,
      source: elementSourceFor(context.environment, iface, iface?.name ?? state.interfaceName ?? '', state.property, undefined, simulated),
      evidence: evidenceUrl(context.packageId, state.property, period.start, period.end),
      runningSeconds: running,
      stoppedSeconds: seconds(totals.stop),
      alarmSeconds: seconds(totals.alarm),
      offSeconds: seconds(totals.off),
      unknownSeconds: seconds(totals.unknown),
    } satisfies MeterReading;
  });
}
