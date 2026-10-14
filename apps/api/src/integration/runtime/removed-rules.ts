/**
 * Closing alarms and threshold crossings whose rule was removed while they were open (review L3).
 *
 * Dropping such a track silently would leave the receiver with an alarm that was raised and never cleared — a CMMS
 * keeps the work request open forever. So the detector emits the closing event itself, marked
 * `reason: 'rule-removed'`, with the details kept on the track while it was open.
 */
import { EVENT_TYPES, type AssetJoin, type ElementSource, type EquipmentAlarmData, type EquipmentThresholdData } from '@aas/core';
import type { DetectorState } from './detector-state.js';

export interface RemovedRulesInput {
  state: DetectorState;
  alarmIds: readonly string[];
  thresholdIds: readonly string[];
  /** Cycle start — the time the removal was noticed (deterministic for a re-processed cycle) */
  at: string;
  asset: AssetJoin;
  resolution: number;
  suppressed: boolean;
  push: (type: string, key: string, time: string, value: unknown, data: Record<string, unknown>) => void;
  sourceForProperty: (property: string) => ElementSource;
}

export function closeRemovedRules(input: RemovedRulesInput): void {
  const { state, at, asset, push, sourceForProperty } = input;
  for (const [id, track] of Object.entries(state.alarms)) {
    if (input.alarmIds.includes(id)) continue;
    delete state.alarms[id];
    if (!track.open || track.instanceId === undefined || track.since === undefined) continue;
    const data: EquipmentAlarmData = {
      asset,
      source: sourceForProperty(track.rule?.property ?? ''),
      alarmRuleId: id,
      alarmInstanceId: track.instanceId,
      code: track.code ?? null,
      text: track.text ?? null,
      severity: track.rule?.severity ?? null,
      raisedAt: track.since,
      detectedAt: at,
      clearedAt: at,
      durationMs: Math.max(0, Date.parse(at) - Date.parse(track.since)),
      occurrences: track.occurrences,
      maintenanceIds: [...(track.rule?.maintenanceIds ?? [])],
      detectionResolutionMs: input.resolution,
      suppressed: input.suppressed,
      reason: 'rule-removed',
    };
    push(EVENT_TYPES.equipmentAlarmCleared, id, at, track.instanceId, data);
  }
  for (const [id, track] of Object.entries(state.thresholds)) {
    if (input.thresholdIds.includes(id)) continue;
    delete state.thresholds[id];
    if (!track.open || !track.rule || !track.last) continue;
    const data: EquipmentThresholdData = {
      asset,
      source: sourceForProperty(track.rule.property),
      thresholdId: id,
      direction: track.rule.direction,
      limit: track.rule.limit,
      hysteresis: track.rule.hysteresis,
      value: track.last.value,
      unit: track.rule.unit,
      severity: track.rule.severity,
      observedAt: track.last.observedAt,
      detectedAt: at,
      suppressed: input.suppressed,
      reason: 'rule-removed',
    };
    push(EVENT_TYPES.equipmentThresholdReturned, id, at, 'returned', data);
  }
}
