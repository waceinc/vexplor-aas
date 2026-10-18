/**
 * The detector's memory between cycles (persisted as runtime state `detector:<packageId>`) and the small sample
 * selection helpers the detection steps share.
 */
import type { AssetJoin, effectiveStateRules, ElementSource, MachineStateOrUnknown, PackageIntegrationConfig } from '@aas/core';
import type { PackageCycle } from '../../supervisor.js';
import type { NewEvent } from '@aas/store';
import type { AlarmTrack } from './alarms.js';
import type { ConnectionTrack } from './connection.js';
import { isGoodQuality, sampleMs, type CounterReading, type RuntimeSample } from './counters.js';
import type { ThresholdTrack } from './thresholds.js';

/** Persisted per package. Versioned so a future shape change can start fresh instead of misreading */
export interface DetectorState {
  version: 1;
  ruleSetHash: string;
  state?: { value: MachineStateOrUnknown; since: string };
  /** Last good reading of the suppress property — "currently reads true" survives cycles without a sample */
  suppressed: boolean;
  alarms: Record<string, AlarmTrack>;
  thresholds: Record<string, ThresholdTrack>;
  counters: Record<string, CounterReading>;
  connections: Record<string, ConnectionTrack>;
  /**
   * Events of the last processed cycle that may not have reached the event log yet. Written **together with** the new
   * state before the events are appended, cleared afterwards; re-appended first on the next cycle (ids are
   * deterministic, so a second append of an already stored event is skipped).
   */
  pending?: NewEvent[];
}

export function detectorStateKey(packageId: string): string {
  return `detector:${packageId}`;
}

export function freshState(hash: string): DetectorState {
  return { version: 1, ruleSetHash: hash, suppressed: false, alarms: {}, thresholds: {}, counters: {}, connections: {} };
}

export function asDetectorState(value: unknown, hash: string): DetectorState {
  if (typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1) {
    return structuredClone(value) as DetectorState;
  }
  return freshState(hash);
}

/** Latest good sample per property of this cycle (optionally of one interface) */
export function latestGood(samples: readonly RuntimeSample[], property: string, interfaceName?: string | null): RuntimeSample | undefined {
  let best: RuntimeSample | undefined;
  for (const sample of samples) {
    if (sample.propertyName !== property || !isGoodQuality(sample.quality) || sample.error !== undefined) continue;
    if (interfaceName && sample.interfaceName !== interfaceName) continue;
    if (!best || sampleMs(sample) >= sampleMs(best)) best = sample;
  }
  return best;
}

/** Drops tracks of rules that no longer exist, so a re-added rule with the same id starts clean */
export function keepOnly<T>(tracks: Record<string, T>, ids: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(tracks).filter(([id]) => ids.includes(id)));
}

/** Everything one detection step needs about the cycle being processed */
export interface DetectContext {
  config: PackageIntegrationConfig;
  rules: ReturnType<typeof effectiveStateRules>;
  hash: string;
  state: DetectorState;
  cycle: PackageCycle;
  asset: AssetJoin;
  subject: string;
  suppressed: boolean;
  push: (type: string, key: string, time: string, value: unknown, data: Record<string, unknown>) => void;
  sourceOf: (sample: RuntimeSample) => ElementSource;
}
