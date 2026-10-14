/**
 * Equipment detector — turns each collection cycle into runtime events: state changes, alarms, threshold crossings,
 * counter advances and connection loss (docs/design/integration-v1.md §6.3).
 *
 * Called by the collection supervisor after every package cycle (`onPackageCycle`). Its memory between cycles lives in
 * the store's runtime state (`detector:<packageId>`), so a restart continues where it stopped instead of announcing
 * every machine's state again.
 *
 * Important: crash consistency (review M1). The supervisor never replays a cycle, so the state and the events of a cycle
 *    must never part. Order: (1) write the new state **with the cycle's events as `pending`** and make it durable,
 *    (2) append the events, (3) clear `pending`. A crash or failure after (1) leaves `pending`, which the next cycle
 *    appends first — the ids are deterministic, so events that did reach the log are skipped. A failure in (1) leaves
 *    the old state and no events, so the next cycle simply measures from the old state (no double count, no re-raise
 *    under a new id).
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
import { asDetectorState, detectorStateKey, keepOnly, latestGood, type DetectContext } from './detector-state.js';
export { detectorStateKey, type DetectorState } from './detector-state.js';
import { elementSourceFor, isVirtualPlc } from './element-ref.js';
import { closeRemovedRules } from './removed-rules.js';
import { ruleSetHash } from './segments.js';
import { detectThresholds } from './thresholds.js';

/**
 * What the detector needs from the store. `flush` (folder store) writes coalesced runtime state to disk now — the
 * detector calls it so the state with `pending` is durable before any event of the cycle becomes visible.
 */
export type DetectorStore = Pick<AasStore, 'getEnvironment'> &
  Pick<IntegrationStore, 'appendEvents' | 'getRuntimeState' | 'putRuntimeState' | 'getPackageIntegrationConfig'> & { flush?: () => Promise<void> };

export interface EquipmentDetectorDeps {
  store: DetectorStore;
  join: AssetJoinResolver;
  /** Default: the built-in virtual PLC check (`isVirtualPlc`) */
  isSimulated?: (iface: AidInterface) => boolean;
  serverConfig: () => Promise<ServerIntegrationConfig>;
  /** Clock for `lastCycleAt` only — never for event content */
  now?: () => string;
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
    // Events of an earlier cycle that may not have reached the log (crash or failure after the state write)
    const replayed = state.pending && state.pending.length > 0 ? await store.appendEvents(state.pending) : [];
    const hadPending = state.pending !== undefined;
    delete state.pending;
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
    closeRemovedRules({
      state,
      alarmIds: config?.alarms.map((rule) => rule.id) ?? [],
      thresholdIds: config?.thresholds.map((rule) => rule.id) ?? [],
      at: cycle.cycle.startedAt,
      asset,
      resolution: cycle.intervalMs,
      suppressed: state.suppressed,
      push,
      sourceForProperty: (property) => {
        const iface = cycle.interfaces.find((candidate) => candidate.properties.some((p) => p.name === property));
        return elementSourceFor(cycle.environment, iface, iface?.name ?? '', property, undefined, iface ? isSimulated(iface) : false);
      },
    });
    detectConnections(config, state, cycle, asset, isSimulated, push);

    let inserted: StoredEvent[] = [];
    if (events.length > 0) {
      await store.putRuntimeState(key, { ...state, pending: events }, packageId);
      await store.flush?.();
      inserted = await store.appendEvents(events);
      // Clearing pending need not be durable at once: if it is lost, the next cycle re-appends and the log skips them
      await store.putRuntimeState(key, state, packageId);
    } else if (hadPending || before === undefined || canonicalJson(before) !== canonicalJson(state)) {
      await store.putRuntimeState(key, state, packageId);
    }
    this.lastCycle = this.deps.now?.() ?? new Date().toISOString();
    return [...replayed, ...inserted];
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
    state.alarms[rule.id] = result.track.open ? { ...result.track, rule: { property: rule.property, severity: rule.severity, maintenanceIds: [...rule.maintenanceIds] } } : result.track;
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
