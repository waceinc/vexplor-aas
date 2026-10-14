/**
 * Shared state logic (moved from the web app) and the event catalogue helpers — docs/design/integration-v1.md §2.3, §6.
 */
import {
  ALL_EVENT_TYPES,
  DEFAULT_STATE_RULES,
  DELIVERABLE_TYPES,
  EVENT_TYPES,
  FRESH_WINDOW_MS,
  eventClassOf,
  freshWindowMs,
  isDeliverableType,
  normalizeState,
  pickStateTag,
  shortEventType,
  stateTimeline,
  stateTotals,
  typeMatches,
  typesMatch,
  type EquipmentStateChangedData,
  type StateRules,
} from '@aas/core';
import { describe, expect, it } from 'vitest';

const MIN = 60_000;

describe('state judgement (core)', () => {
  it('a value outside the rules is undetermined, never mapped to stop (MES B unknown value)', () => {
    expect(normalizeState({ valueText: 'MAINT' })).toBeUndefined();
    expect(normalizeState({ valueNumber: 7 })).toBeUndefined();
    expect(normalizeState({ valueText: '   ' })).toBeUndefined();
    expect(normalizeState({})).toBeUndefined();
  });

  it('reads text before the number, ignoring case, spaces, underscores and hyphens', () => {
    expect(normalizeState({ valueText: 'Power_Off', valueNumber: 1 })).toBe('off');
    expect(normalizeState({ valueText: '', valueNumber: 1 })).toBe('run');
    expect(normalizeState({ valueText: 'E-MERGENCY' })).toBe('alarm');
  });

  it('a word listed under two states resolves by the fixed order alarm, off, run, stop', () => {
    const rules: StateRules = { run: ['x'], stop: ['x'], alarm: ['x'], off: ['x'] };
    expect(normalizeState({ valueText: 'x' }, rules)).toBe('alarm');
    expect(normalizeState({ valueText: 'x' }, { ...rules, alarm: [] })).toBe('off');
    expect(normalizeState({ valueText: 'x' }, { ...rules, alarm: [], off: [] })).toBe('run');
  });

  it('custom rules replace the defaults instead of adding to them', () => {
    const rules: StateRules = { run: ['2'], stop: [], alarm: ['3'], off: [] };
    expect(normalizeState({ valueNumber: 3 }, rules)).toBe('alarm');
    expect(normalizeState({ valueNumber: 1 }, rules)).toBeUndefined();
  });

  it('picks a state tag only when exactly one name matches', () => {
    expect(pickStateTag(['MachineState', 'Temp'])).toBe('MachineState');
    expect(pickStateTag(['State', 'Status'])).toBeUndefined();
  });

  it('timeline: hold window, no-data gaps, merged equal states; totals add up to the window', () => {
    const start = 0;
    const end = 60 * MIN;
    const segments = stateTimeline(
      [
        { at: 0, state: 'run' },
        { at: 5 * MIN, state: 'run' },
        { at: 10 * MIN, state: 'alarm' },
        { at: 40 * MIN, state: undefined },
      ],
      start,
      end,
      5 * MIN,
    );
    expect(segments).toEqual([
      { from: 0, to: 10 * MIN, state: 'run' },
      { from: 10 * MIN, to: 15 * MIN, state: 'alarm' },
      { from: 15 * MIN, to: 40 * MIN, state: 'none' },
      { from: 40 * MIN, to: 45 * MIN, state: 'unknown' },
      { from: 45 * MIN, to: 60 * MIN, state: 'none' },
    ]);
    const totals = stateTotals(segments);
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(end - start);
    expect(totals.run).toBe(10 * MIN);
  });

  it('fresh window: 5 minutes or 3x the collection interval, whichever is larger', () => {
    expect(FRESH_WINDOW_MS).toBe(5 * MIN);
    expect(freshWindowMs(undefined)).toBe(5 * MIN);
    expect(freshWindowMs(30_000)).toBe(5 * MIN);
    expect(freshWindowMs(10 * MIN)).toBe(30 * MIN);
  });

  it('default rules keep the Korean equipment words', () => {
    expect(DEFAULT_STATE_RULES.run).toContain('가동');
    expect(normalizeState({ valueText: '고장' })).toBe('alarm');
  });
});

describe('event catalogue', () => {
  it('every type is kr.vexplor.aas.<name>.v1 and unique', () => {
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
    for (const type of ALL_EVENT_TYPES) expect(type).toMatch(/^kr\.vexplor\.aas\.[a-z.]+\.v1$/);
    expect(ALL_EVENT_TYPES).toHaveLength(27);
  });

  it('audit and ping are never deliverable; everything else is', () => {
    expect(isDeliverableType(EVENT_TYPES.integrationAudit)).toBe(false);
    expect(isDeliverableType(EVENT_TYPES.integrationPing)).toBe(false);
    expect(DELIVERABLE_TYPES).toHaveLength(ALL_EVENT_TYPES.length - 2);
    expect(isDeliverableType(EVENT_TYPES.equipmentStateChanged)).toBe(true);
    expect(isDeliverableType('kr.vexplor.aas.unknown.v1')).toBe(false);
  });

  it('classifies types as model, projection, runtime, audit, test', () => {
    expect(eventClassOf(EVENT_TYPES.modelSubmodelUpdated)).toBe('model');
    expect(eventClassOf(EVENT_TYPES.equipmentMasterChanged)).toBe('projection');
    expect(eventClassOf(EVENT_TYPES.equipmentDocumentsChanged)).toBe('projection');
    expect(eventClassOf(EVENT_TYPES.equipmentStateChanged)).toBe('runtime');
    expect(eventClassOf(EVENT_TYPES.collectionConnectionLost)).toBe('runtime');
    expect(eventClassOf(EVENT_TYPES.integrationAudit)).toBe('audit');
    expect(eventClassOf(EVENT_TYPES.integrationPing)).toBe('test');
    expect(eventClassOf('something.else')).toBeUndefined();
  });

  it('type filters: exact, prefix with *, short form without the kr.vexplor.aas. prefix', () => {
    const state = EVENT_TYPES.equipmentStateChanged;
    expect(typeMatches(state, state)).toBe(true);
    expect(typeMatches('equipment.state.changed.v1', state)).toBe(true);
    expect(typeMatches('equipment.*', state)).toBe(true);
    expect(typeMatches('kr.vexplor.aas.equipment.*', state)).toBe(true);
    expect(typeMatches('*', state)).toBe(true);
    expect(typeMatches('equipment.state', state)).toBe(false);
    expect(typeMatches('model.*', state)).toBe(false);
    expect(typeMatches('equipment.alarm.raised.v1', state)).toBe(false);
    expect(typesMatch(undefined, state)).toBe(true);
    expect(typesMatch([], state)).toBe(true);
    expect(typesMatch(['model.*', 'equipment.state.*'], state)).toBe(true);
    expect(typesMatch(['model.*'], state)).toBe(false);
    expect(shortEventType(state)).toBe('equipment.state.changed.v1');
  });

  it('payload types are assignable to the store row data shape', () => {
    // Compile-time contract: payloads are type aliases so they fit Record<string, unknown> without a cast
    const asData = (data: Record<string, unknown>): Record<string, unknown> => data;
    const payload = {} as EquipmentStateChangedData;
    expect(asData(payload)).toBe(payload);
  });
});
