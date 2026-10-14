/**
 * Equipment detector — turns each collection cycle into runtime events: state changes, alarms, threshold crossings,
 * counter advances and connection loss (docs/design/integration-v1.md §6.3).
 *
 * Called by the collection supervisor after every package cycle (`onPackageCycle`). Its memory between cycles lives in
 * the store's runtime state (`detector:<packageId>`), so a restart continues where it stopped instead of announcing
 * every machine's state again.
 *
 * Important: crash safety comes from deterministic event ids, not from transactions. Events are appended first, the
 *    state second. If the process dies in between, the next run processes the same samples from the old state, produces
 *    the same ids, and the store skips them — the receiver sees each event once.
 * Important: never put the processing time into an event id or a time field that feeds one — only sample times and the
 *    cycle start, which are the same when a cycle is processed again.
 */
import type { AidInterface } from '@aas/collector';
import {
  EVENT_TYPES,
  effectiveStateRules,
  normalizeState,
  parsePackageIntegrationConfig,
  type AssetJoin,
  type AssetJoinResolver,
  type ElementSource,
  type EquipmentAlarmData,
  type EquipmentCounterAdvancedData,
  type EquipmentStateChangedData,
  type EquipmentThresholdData,
  type MachineStateOrUnknown,
  type PackageIntegrationConfig,
  type ServerIntegrationConfig,
} from '@aas/core';
import { freshWindowMs } from '@aas/core';
import type { AasStore, IntegrationStore, NewEvent, StoredEvent } from '@aas/store';
import type { PackageCycle } from '../../supervisor.js';
import { alarmInstanceIdFor, canonicalJson, eventIdFor } from '../ids.js';
import { isAlarmActive, stepAlarm, type AlarmTrack } from './alarms.js';
import { detectConnections } from './connection.js';
import { counterReadings, counterSteps, numericValue, sampleTime, textValue, type RuntimeSample } from './counters.js';
import { asDetectorState, detectorStateKey, keepOnly, latestGood, type DetectorState } from './detector-state.js';
export { detectorStateKey, type DetectorState } from './detector-state.js';
import { elementSourceFor, isVirtualPlc } from './element-ref.js';
import { ruleSetHash } from './segments.js';
import { stepThreshold } from './thresholds.js';

/** What the detector needs from the store — `AasStore` satisfies it once the integration port is merged into it */
export type DetectorStore = Pick<AasStore, 'getEnvironment'> &
  Pick<IntegrationStore, 'appendEvents' | 'getRuntimeState' | 'putRuntimeState' | 'getPackageIntegrationConfig'>;

export interface EquipmentDetectorDeps {
  store: DetectorStore;
  join: AssetJoinResolver;
  /** Default: the built-in virtual PLC check (`isVirtualPlc`) */
  isSimulated?: (iface: AidInterface) => boolean;
  serverConfig: () => Promise<ServerIntegrationConfig>;
  /** Clock for `lastCycleAt` only — never for event content */
  now?: () => string;
}

/** Everything one detection step needs about the cycle being processed */
interface DetectContext {
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

export class EquipmentDetector {
  private lastCycle: string | undefined;

  constructor(private readonly deps: EquipmentDetectorDeps) {}

  /** Time the last cycle finished processing — for `/integrations/status` */
  get lastCycleAt(): string | undefined {
    return this.lastCycle;
  }

  /** Processes one package cycle; returns the events actually appended (duplicates of a re-processed cycle excluded) */
  async onPackageCycle(cycle: PackageCycle): Promise<StoredEvent[]> {
    const { store } = this.deps;
    const packageId = cycle.record.id;
    const asset = await this.deps.join(packageId);
    if (!asset) return []; // the package was deleted while the cycle ran

    const stored = await store.getPackageIntegrationConfig(packageId);
    const parsed = stored ? parsePackageIntegrationConfig(stored.value) : undefined;
    // A stored config that no longer parses (written by a newer version?) is treated as absent, never half-applied
    const config: PackageIntegrationConfig | null = parsed?.ok ? parsed.value : null;
    const server = await this.deps.serverConfig();
    const rules = effectiveStateRules(server, config);
    const hash = ruleSetHash(rules);

    const key = detectorStateKey(packageId);
    const before = await store.getRuntimeState(key);
    const state = asDetectorState(before, hash);
    const subject = asset.globalAssetId ?? packageId;
    const isSimulated = this.deps.isSimulated ?? isVirtualPlc;
    const ifaceByName = new Map(cycle.interfaces.map((iface) => [iface.name, iface]));
    const events: NewEvent[] = [];
    const push = (type: string, key: string, time: string, value: unknown, data: Record<string, unknown>): void => {
      events.push({ id: eventIdFor(type, subject, key, time, value), type, time, packageId, ...(asset.globalAssetId ? { subject: asset.globalAssetId } : {}), data });
    };
    const sourceOf = (sample: RuntimeSample) => {
      const iface = ifaceByName.get(sample.interfaceName);
      return elementSourceFor(cycle.environment, iface, sample.interfaceName, sample.propertyName, sample.source, iface ? isSimulated(iface) : false);
    };

    if (config) {
      if (config.suppressProperty) {
        const sample = latestGood(cycle.samples, config.suppressProperty);
        if (sample) state.suppressed = isAlarmActive(sample, 'truthy');
      } else state.suppressed = false;

      const context: DetectContext = { config, rules, hash, state, cycle, asset, subject, suppressed: state.suppressed, push, sourceOf };
      detectState(context);
      detectAlarms(context);
      detectThresholds(context);
      detectCounters(context);
    } else state.ruleSetHash = hash;
    detectConnections(config, state, cycle, asset, isSimulated, push);

    const inserted = events.length > 0 ? await store.appendEvents(events) : [];
    if (before === undefined || canonicalJson(before) !== canonicalJson(state)) await store.putRuntimeState(key, state, packageId);
    this.lastCycle = this.deps.now?.() ?? new Date().toISOString();
    return inserted;
  }
}

function detectState(ctx: DetectContext): void {
const { config, rules, hash, state, cycle, asset, suppressed, push, sourceOf } = ctx;
const resolution = cycle.intervalMs;
  if (!config.state) {
    state.ruleSetHash = hash;
    return;
  }
  const sample = latestGood(cycle.samples, config.state.property, config.state.interfaceName);
  // Important: no sample, no hash update — the stored label was made under the old rules and is re-labelled only
  //    when a value is at hand; moving the hash now would turn the next re-label into a spurious change event
  if (!sample) return;
  const value: MachineStateOrUnknown = normalizeState(sample, rules) ?? 'unknown';
  const at = sampleTime(sample);
  if (!state.state) {
    // First observation ever: record without an event — "changed" from nothing is not a change
    state.state = { value, since: at };
    state.ruleSetHash = hash;
    return;
  }
  if (state.ruleSetHash !== hash) {
    // New rules: re-label silently; the next real change carries the new hash
    if (value !== state.state.value) state.state = { value, since: state.state.since };
    state.ruleSetHash = hash;
    return;
  }
  if (value === state.state.value) return;
  const previous = state.state;
  const data: EquipmentStateChangedData = {
    asset,
    source: sourceOf(sample),
    state: value,
    previousState: previous.value,
    previousStateSince: previous.since,
    previousDurationMs: Math.max(0, Date.parse(at) - Date.parse(previous.since)),
    rawValue: textValue(sample),
    ruleSetHash: hash,
    observedAt: sample.observedAt,
    receivedAt: sample.receivedAt ?? null,
    quality: sample.quality ?? null,
    detectionResolutionMs: resolution,
    suppressed,
  };
  push(EVENT_TYPES.equipmentStateChanged, 'state', at, value, data);
  state.state = { value, since: at };
}

function detectAlarms(ctx: DetectContext): void {
const { config, state, cycle, asset, subject, suppressed, push, sourceOf } = ctx;
const resolution = cycle.intervalMs;
  state.alarms = keepOnly(state.alarms, config.alarms.map((rule) => rule.id));
  for (const rule of config.alarms) {
    const sample = latestGood(cycle.samples, rule.property);
    if (!sample) continue;
    const at = sampleTime(sample);
    const detail = (property: string | null): string | null => {
      if (!property) return null;
      const found = latestGood(cycle.samples, property);
      return found ? textValue(found) : null;
    };
    const track: AlarmTrack = state.alarms[rule.id] ?? { open: false, pendingCount: 0, occurrences: 0 };
    const result = stepAlarm(track, isAlarmActive(sample, rule.activeWhen), at, rule, (raisedAt) => alarmInstanceIdFor(subject, rule.id, raisedAt), {
      code: detail(rule.codeProperty),
      text: detail(rule.textProperty),
    });
    state.alarms[rule.id] = result.track;
    const base = { asset, source: sourceOf(sample), alarmRuleId: rule.id, severity: rule.severity, maintenanceIds: [...rule.maintenanceIds], detectionResolutionMs: resolution, suppressed };
    if (result.raised) {
      const data: EquipmentAlarmData = {
        ...base,
        alarmInstanceId: result.raised.instanceId,
        code: result.track.code ?? null,
        text: result.track.text ?? null,
        raisedAt: result.raised.raisedAt,
        detectedAt: at,
        clearedAt: null,
        durationMs: null,
        occurrences: 1,
      };
      push(EVENT_TYPES.equipmentAlarmRaised, rule.id, result.raised.raisedAt, result.raised.instanceId, data);
    }
    if (result.cleared) {
      const cleared = result.cleared;
      const data: EquipmentAlarmData = {
        ...base,
        alarmInstanceId: cleared.instanceId,
        code: cleared.code,
        text: cleared.text,
        raisedAt: cleared.raisedAt,
        detectedAt: at,
        clearedAt: cleared.clearedAt,
        durationMs: Math.max(0, Date.parse(cleared.clearedAt) - Date.parse(cleared.raisedAt)),
        occurrences: cleared.occurrences,
      };
      push(EVENT_TYPES.equipmentAlarmCleared, rule.id, cleared.clearedAt, cleared.instanceId, data);
    }
  }
}

function detectThresholds(ctx: DetectContext): void {
const { config, state, cycle, asset, suppressed, push, sourceOf } = ctx;
  state.thresholds = keepOnly(state.thresholds, config.thresholds.map((rule) => rule.id));
  for (const rule of config.thresholds) {
    const sample = latestGood(cycle.samples, rule.property);
    const value = sample ? numericValue(sample) : undefined;
    if (!sample || value === undefined) continue;
    const at = sampleTime(sample);
    const result = stepThreshold(state.thresholds[rule.id] ?? { open: false, pendingCount: 0 }, value, at, rule);
    state.thresholds[rule.id] = result.track;
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

function detectCounters(ctx: DetectContext): void {
const { config, state, cycle, asset, push, sourceOf } = ctx;
const freshMs = freshWindowMs(cycle.intervalMs);
  state.counters = keepOnly(state.counters, config.counters.map((rule) => rule.id));
  for (const rule of config.counters) {
    const own = cycle.samples.filter((sample) => sample.propertyName === rule.property);
    const { readings, excludedBadSamples } = counterReadings(own);
    if (readings.length === 0) continue;
    const steps = counterSteps(readings, rule, freshMs, state.counters[rule.id]);
    state.counters[rule.id] = readings[readings.length - 1]!;
    const source = sourceOf(latestGood(own, rule.property)!);
    steps.forEach((step, index) => {
      const data: EquipmentCounterAdvancedData = {
        asset,
        source,
        counterId: rule.id,
        counterKind: rule.kind,
        unit: rule.unit,
        from: step.from,
        to: step.to,
        delta: step.delta,
        intervalStart: step.intervalStart,
        intervalEnd: step.intervalEnd,
        flags: step.flags,
        // The cycle's bad samples are reported once, on its last step, so summing events does not count them twice
        excludedBadSamples: index === steps.length - 1 ? excludedBadSamples : 0,
      };
      push(EVENT_TYPES.equipmentCounterAdvanced, rule.id, step.intervalEnd, { from: step.from, to: step.to }, data);
    });
  }
}
