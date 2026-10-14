/**
 * Integration configuration parsers — every invalid sample must be rejected with a JSON Pointer to the problem,
 * every valid sample must come back complete (defaults filled). docs/design/integration-v1.md §4.3.
 */
import {
  DEFAULT_STATE_RULES,
  PACKAGE_CONFIG_SCHEMA,
  SERVER_CONFIG_SCHEMA,
  defaultPackageIntegrationConfig,
  defaultServerIntegrationConfig,
  effectiveStateRules,
  parsePackageIntegrationConfig,
  parseServerIntegrationConfig,
  ruleSetHashInput,
  setLangSource,
  tr,
  type ParseResult,
} from '@aas/core';
import { describe, expect, it } from 'vitest';

const DESIGN_SERVER_SAMPLE = {
  schema: SERVER_CONFIG_SCHEMA,
  instanceId: '9f2c4e1a7b3d',
  stateRules: { run: ['가동', 'run', '1'], stop: ['정지'], alarm: ['알람'], off: ['전원꺼짐'] },
  timezone: 'Asia/Seoul',
  dayStartHour: 8,
  shifts: [
    { name: 'A', start: '08:00', end: '20:00' },
    { name: 'B', start: '20:00', end: '08:00' },
  ],
};

const DESIGN_PACKAGE_SAMPLE = {
  schema: PACKAGE_CONFIG_SCHEMA,
  state: { property: 'MachineState', interfaceName: 'PLC1', rules: null },
  alarms: [
    { id: 'alarm-main', property: 'AlarmActive', activeWhen: 'truthy', codeProperty: 'AlarmCode', textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] },
  ],
  counters: [
    { id: 'produced', property: 'ProductionCount', kind: 'total', unit: null, max: null, maxRatePerHour: null },
    { id: 'runHours', property: 'CumulativeRunHours', kind: 'runHours', unit: 'h', max: null, maxRatePerHour: 1 },
  ],
  thresholds: [
    { id: 'motor-temp-high', property: 'MotorTemperature', direction: 'above', limit: 85, hysteresis: 2, unit: 'degC', severity: null, raiseSamples: 2, clearSamples: 2 },
  ],
  suppressProperty: 'MaintenanceMode',
  connection: { lostAfterFailures: 2 },
  isa95: { site: 'Changwon', levels: { 'WACE/Line-A': 'WorkCenter' } },
};

function paths<T>(result: ParseResult<T>): string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map((error) => error.path);
}

const withServer = (patch: Record<string, unknown>): unknown => ({ ...DESIGN_SERVER_SAMPLE, ...patch });
const withPackage = (patch: Record<string, unknown>): unknown => ({ ...DESIGN_PACKAGE_SAMPLE, ...patch });

describe('server integration config', () => {
  it('accepts the design sample unchanged', () => {
    const result = parseServerIntegrationConfig(DESIGN_SERVER_SAMPLE);
    expect(result).toEqual({ ok: true, value: DESIGN_SERVER_SAMPLE });
  });

  it('fills every optional field with its default', () => {
    const result = parseServerIntegrationConfig({ schema: SERVER_CONFIG_SCHEMA });
    expect(result).toEqual({ ok: true, value: defaultServerIntegrationConfig() });
    if (result.ok) {
      expect(result.value.stateRules).toEqual(DEFAULT_STATE_RULES);
      expect(result.value.stateRules.run).not.toBe(DEFAULT_STATE_RULES.run); // a copy, so editing it cannot change the defaults
      expect(result.value).toMatchObject({ timezone: 'Asia/Seoul', dayStartHour: 8, shifts: [], instanceId: '' });
    }
  });

  it('the default rules pass their own validation (no word in two states)', () => {
    expect(parseServerIntegrationConfig({ schema: SERVER_CONFIG_SCHEMA, stateRules: DEFAULT_STATE_RULES }).ok).toBe(true);
  });

  const invalid: [string, unknown, string][] = [
    ['not an object', [], '/'],
    ['null', null, '/'],
    ['wrong schema', withServer({ schema: 'vexplor.serverIntegrationConfig/2' }), '/schema'],
    ['missing schema', { stateRules: DEFAULT_STATE_RULES }, '/schema'],
    ['unknown field (typo)', withServer({ dayStartHours: 8 }), '/dayStartHours'],
    ['instanceId not 12 hex', withServer({ instanceId: 'XYZ' }), '/instanceId'],
    ['stateRules missing a state', withServer({ stateRules: { run: [], stop: [], alarm: [] } }), '/stateRules/off'],
    ['stateRules unknown state', withServer({ stateRules: { ...DEFAULT_STATE_RULES, idle: ['x'] } }), '/stateRules/idle'],
    ['stateRules not a list', withServer({ stateRules: { ...DEFAULT_STATE_RULES, run: 'run' } }), '/stateRules/run'],
    ['stateRules empty word', withServer({ stateRules: { ...DEFAULT_STATE_RULES, run: ['run', ' '] } }), '/stateRules/run/1'],
    ['word in two states (after normalising)', withServer({ stateRules: { run: ['Run'], stop: ['r u n'], alarm: [], off: [] } }), '/stateRules/stop'],
    ['unknown time zone', withServer({ timezone: 'Mars/Olympus' }), '/timezone'],
    ['dayStartHour 24', withServer({ dayStartHour: 24 }), '/dayStartHour'],
    ['dayStartHour fraction', withServer({ dayStartHour: 7.5 }), '/dayStartHour'],
    ['dayStartHour string', withServer({ dayStartHour: '8' }), '/dayStartHour'],
    ['shift bad time', withServer({ shifts: [{ name: 'A', start: '8:00', end: '20:00' }] }), '/shifts/0/start'],
    ['shift 24:00', withServer({ shifts: [{ name: 'A', start: '08:00', end: '24:00' }] }), '/shifts/0/end'],
    ['shift start = end', withServer({ shifts: [{ name: 'A', start: '08:00', end: '08:00' }] }), '/shifts/0/end'],
    ['shift duplicate name', withServer({ shifts: [{ name: 'A', start: '08:00', end: '20:00' }, { name: 'A', start: '20:00', end: '08:00' }] }), '/shifts/1/name'],
    ['shift missing name', withServer({ shifts: [{ start: '08:00', end: '20:00' }] }), '/shifts/0/name'],
    ['shift unknown field', withServer({ shifts: [{ name: 'A', start: '08:00', end: '20:00', break: 30 }] }), '/shifts/0/break'],
    ['shifts not a list', withServer({ shifts: {} }), '/shifts'],
  ];
  for (const [name, input, path] of invalid) {
    it(`rejects: ${name}`, () => {
      expect(paths(parseServerIntegrationConfig(input))).toContain(path);
    });
  }

  it('reports every error at once, with a translatable message', () => {
    const result = parseServerIntegrationConfig(withServer({ dayStartHour: 30, timezone: 'Nowhere/None' }));
    expect(paths(result)).toEqual(['/timezone', '/dayStartHour']);
    if (!result.ok) expect(result.errors[1]!.message).toBe(tr('{0}~{1} 사이의 정수여야 합니다.').replace('{0}', '0').replace('{1}', '23'));
    // The same input in English comes out fully translated
    setLangSource(() => 'en');
    try {
      const english = parseServerIntegrationConfig(withServer({ dayStartHour: 30, timezone: 'Nowhere/None' }));
      expect(english.ok ? [] : english.errors.map((error) => error.message)).toEqual(['Unknown time zone: Nowhere/None', 'Must be an integer from 0 to 23.']);
    } finally {
      setLangSource(() => 'ko');
    }
  });
});

describe('package integration config', () => {
  it('accepts the design sample unchanged', () => {
    expect(parsePackageIntegrationConfig(DESIGN_PACKAGE_SAMPLE)).toEqual({ ok: true, value: DESIGN_PACKAGE_SAMPLE });
  });

  it('fills defaults: no state tag, empty rule lists, 2 failures, no ISA-95 override', () => {
    expect(parsePackageIntegrationConfig({ schema: PACKAGE_CONFIG_SCHEMA })).toEqual({ ok: true, value: defaultPackageIntegrationConfig() });
  });

  it('fills rule defaults: raise/clear 1, hysteresis 0, nullable fields null, activeWhen truthy', () => {
    const result = parsePackageIntegrationConfig({
      schema: PACKAGE_CONFIG_SCHEMA,
      alarms: [{ id: 'a', property: 'Alarm' }],
      counters: [{ id: 'c', property: 'Count', kind: 'good' }],
      thresholds: [{ id: 't', property: 'Temp', direction: 'below', limit: -5 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alarms[0]).toEqual({ id: 'a', property: 'Alarm', activeWhen: 'truthy', codeProperty: null, textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] });
    expect(result.value.counters[0]).toEqual({ id: 'c', property: 'Count', kind: 'good', unit: null, max: null, maxRatePerHour: null });
    expect(result.value.thresholds[0]).toEqual({ id: 't', property: 'Temp', direction: 'below', limit: -5, hysteresis: 0, unit: null, severity: null, raiseSamples: 1, clearSamples: 1 });
  });

  it('accepts activeWhen equals and a per-package rule override', () => {
    const result = parsePackageIntegrationConfig(withPackage({
      state: { property: 'S', rules: { run: ['2'], stop: ['1'], alarm: ['3'], off: [] } },
      alarms: [{ id: 'a', property: 'Mode', activeWhen: { equals: ['ALARM', '3'] } }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alarms[0]!.activeWhen).toEqual({ equals: ['ALARM', '3'] });
    expect(result.value.state).toEqual({ property: 'S', interfaceName: null, rules: { run: ['2'], stop: ['1'], alarm: ['3'], off: [] } });
  });

  const alarm = DESIGN_PACKAGE_SAMPLE.alarms[0]!;
  const counter = DESIGN_PACKAGE_SAMPLE.counters[0]!;
  const threshold = DESIGN_PACKAGE_SAMPLE.thresholds[0]!;
  const invalid: [string, unknown, string][] = [
    ['not an object', 'x', '/'],
    ['wrong schema', withPackage({ schema: SERVER_CONFIG_SCHEMA }), '/schema'],
    ['unknown field', withPackage({ alarm: [] }), '/alarm'],
    ['state without property', withPackage({ state: { interfaceName: 'PLC1' } }), '/state/property'],
    ['state property empty', withPackage({ state: { property: '' } }), '/state/property'],
    ['state rules invalid', withPackage({ state: { property: 'S', rules: { run: [] } } }), '/state/rules/stop'],
    ['alarm id with space', withPackage({ alarms: [{ ...alarm, id: 'main alarm' }] }), '/alarms/0/id'],
    ['alarm id too long', withPackage({ alarms: [{ ...alarm, id: 'a'.repeat(65) }] }), '/alarms/0/id'],
    ['alarm duplicate id', withPackage({ alarms: [alarm, { ...alarm }] }), '/alarms/1/id'],
    ['alarm missing property', withPackage({ alarms: [{ id: 'a' }] }), '/alarms/0/property'],
    ['alarm activeWhen unknown', withPackage({ alarms: [{ ...alarm, activeWhen: 'falsy' }] }), '/alarms/0/activeWhen'],
    ['alarm activeWhen empty equals', withPackage({ alarms: [{ ...alarm, activeWhen: { equals: [] } }] }), '/alarms/0/activeWhen/equals'],
    ['alarm raiseSamples 0', withPackage({ alarms: [{ ...alarm, raiseSamples: 0 }] }), '/alarms/0/raiseSamples'],
    ['alarm clearSamples 101', withPackage({ alarms: [{ ...alarm, clearSamples: 101 }] }), '/alarms/0/clearSamples'],
    ['alarm unknown field', withPackage({ alarms: [{ ...alarm, raiseSample: 2 }] }), '/alarms/0/raiseSample'],
    ['alarms not a list', withPackage({ alarms: alarm }), '/alarms'],
    ['too many alarms', withPackage({ alarms: Array.from({ length: 101 }, (_, i) => ({ ...alarm, id: `a${i}` })) }), '/alarms'],
    ['counter kind unknown', withPackage({ counters: [{ ...counter, kind: 'scrap' }] }), '/counters/0/kind'],
    ['counter reserved id runtime', withPackage({ counters: [{ ...counter, id: 'runtime' }] }), '/counters/0/id'],
    ['counter max 0', withPackage({ counters: [{ ...counter, max: 0 }] }), '/counters/0/max'],
    ['counter max fraction', withPackage({ counters: [{ ...counter, max: 655.35 }] }), '/counters/0/max'],
    ['counter rate negative', withPackage({ counters: [{ ...counter, maxRatePerHour: -1 }] }), '/counters/0/maxRatePerHour'],
    ['counter duplicate id', withPackage({ counters: [counter, counter] }), '/counters/1/id'],
    ['threshold direction', withPackage({ thresholds: [{ ...threshold, direction: 'over' }] }), '/thresholds/0/direction'],
    ['threshold limit missing', withPackage({ thresholds: [{ ...threshold, limit: undefined }] }), '/thresholds/0/limit'],
    ['threshold limit NaN', withPackage({ thresholds: [{ ...threshold, limit: Number.NaN }] }), '/thresholds/0/limit'],
    ['threshold limit text', withPackage({ thresholds: [{ ...threshold, limit: '85' }] }), '/thresholds/0/limit'],
    ['threshold negative hysteresis', withPackage({ thresholds: [{ ...threshold, hysteresis: -2 }] }), '/thresholds/0/hysteresis'],
    ['suppressProperty not text', withPackage({ suppressProperty: true }), '/suppressProperty'],
    ['lostAfterFailures 0', withPackage({ connection: { lostAfterFailures: 0 } }), '/connection/lostAfterFailures'],
    ['connection unknown field', withPackage({ connection: { lostAfter: 2 } }), '/connection/lostAfter'],
    ['isa95 unknown level', withPackage({ isa95: { site: null, levels: { 'WACE/Line-A': 'Line' } } }), '/isa95/levels/WACE~1Line-A'],
    ['isa95 empty path', withPackage({ isa95: { levels: { ' ': 'Area' } } }), '/isa95/levels/ '],
    ['isa95 levels not an object', withPackage({ isa95: { levels: ['Area'] } }), '/isa95/levels'],
  ];
  for (const [name, input, path] of invalid) {
    it(`rejects: ${name}`, () => {
      expect(paths(parsePackageIntegrationConfig(input))).toContain(path);
    });
  }
});

describe('rule set hash input', () => {
  it('equal judgement gives equal text: order, case, spacing and duplicates do not matter', () => {
    const a = { run: ['Run', 'on'], stop: ['stop'], alarm: ['fault'], off: [] };
    const b = { run: ['on', 'R U N', 'run'], stop: ['STOP'], alarm: ['Fault'], off: [] };
    expect(ruleSetHashInput(a)).toBe(ruleSetHashInput(b));
  });

  it('a word moved to another state changes the text', () => {
    const a = { run: ['1'], stop: ['0'], alarm: [], off: [] };
    const b = { run: ['1'], stop: [], alarm: ['0'], off: [] };
    expect(ruleSetHashInput(a)).not.toBe(ruleSetHashInput(b));
  });

  it('the package override wins over the server rules', () => {
    const server = defaultServerIntegrationConfig();
    const own = { run: ['2'], stop: [], alarm: [], off: [] };
    expect(effectiveStateRules(server, null)).toBe(server.stateRules);
    expect(effectiveStateRules(server, { state: { property: 'S', interfaceName: null, rules: null } })).toBe(server.stateRules);
    expect(effectiveStateRules(server, { state: { property: 'S', interfaceName: null, rules: own } })).toBe(own);
  });
});
