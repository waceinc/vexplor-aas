/**
 * Integration configuration — server-wide (state rules, time zone, day start, shifts) and per package (state tag,
 * alarm / counter / threshold rules, suppression, ISA-95 overrides). docs/design/integration-v1.md §4.3.
 *
 * The store keeps both as opaque JSON; these parsers are the only gate. They return the **complete** value with every
 * optional field filled with its default, so consumers never branch on "missing".
 *
 * Important: strict — an unknown field is an error, not ignored. A typo such as `raiseSample` would otherwise silently
 *    fall back to the default and the rule would behave differently from what the person wrote.
 * Important: error paths are JSON Pointers (`/alarms/0/raiseSamples`), the same notation the rest of the API uses.
 * Important: browser-safe — no `node:` imports (the UI validates before saving with the same parser).
 */
import { fill, tr } from '../i18n/index.js';
import { COUNTER_KINDS, type CounterKind, type ThresholdDirection } from './events.js';
import { DEFAULT_STATE_RULES, MACHINE_STATES, normalizeStateWord, type MachineState, type StateRules } from './states.js';

export const SERVER_CONFIG_SCHEMA = 'vexplor.serverIntegrationConfig/1';
export const PACKAGE_CONFIG_SCHEMA = 'vexplor.packageIntegrationConfig/1';

export const DEFAULT_TIMEZONE = 'Asia/Seoul';
export const DEFAULT_DAY_START_HOUR = 8;
export const DEFAULT_LOST_AFTER_FAILURES = 2;
/** Reserved counter id — `/integrations/meters?counter=runtime` means the computed run time, not a device counter */
export const RESERVED_COUNTER_ID = 'runtime';

export interface ShiftDefinition {
  name: string;
  /** "HH:MM" in the configured time zone */
  start: string;
  /** "HH:MM"; earlier than start means the shift ends the next day */
  end: string;
}

export interface ServerIntegrationConfig {
  schema: typeof SERVER_CONFIG_SCHEMA;
  /** 12 hex chars, server-owned. '' when the input had none — the API layer always overwrites it with the stored id */
  instanceId: string;
  stateRules: StateRules;
  timezone: string;
  dayStartHour: number;
  shifts: ShiftDefinition[];
}

export type AlarmActiveWhen = 'truthy' | { equals: string[] };

export interface AlarmRule {
  id: string;
  property: string;
  activeWhen: AlarmActiveWhen;
  codeProperty: string | null;
  textProperty: string | null;
  severity: string | null;
  raiseSamples: number;
  clearSamples: number;
  maintenanceIds: string[];
}

export interface CounterRule {
  id: string;
  property: string;
  kind: CounterKind;
  unit: string | null;
  /** Device counter maximum (e.g. 65535). Only when set is a decrease read as a rollover (D13) */
  max: number | null;
  maxRatePerHour: number | null;
}

export interface ThresholdRule {
  id: string;
  property: string;
  direction: ThresholdDirection;
  limit: number;
  hysteresis: number;
  unit: string | null;
  severity: string | null;
  raiseSamples: number;
  clearSamples: number;
}

export const ISA95_LEVELS = ['Enterprise', 'Site', 'Area', 'WorkCenter', 'WorkUnit'] as const;
export type Isa95Level = (typeof ISA95_LEVELS)[number];

export interface PackageStateConfig {
  property: string;
  interfaceName: string | null;
  /** Package override of the server rules; null = use the server rules */
  rules: StateRules | null;
}

export interface PackageIntegrationConfig {
  schema: typeof PACKAGE_CONFIG_SCHEMA;
  state: PackageStateConfig | null;
  alarms: AlarmRule[];
  counters: CounterRule[];
  thresholds: ThresholdRule[];
  suppressProperty: string | null;
  connection: { lostAfterFailures: number };
  /** `levels` is keyed by the `/`-joined node path of the process file hierarchy */
  isa95: { site: string | null; levels: Record<string, Isa95Level> };
}

export function defaultServerIntegrationConfig(instanceId = ''): ServerIntegrationConfig {
  return {
    schema: SERVER_CONFIG_SCHEMA,
    instanceId,
    stateRules: copyRules(DEFAULT_STATE_RULES),
    timezone: DEFAULT_TIMEZONE,
    dayStartHour: DEFAULT_DAY_START_HOUR,
    shifts: [],
  };
}

export function defaultPackageIntegrationConfig(): PackageIntegrationConfig {
  return {
    schema: PACKAGE_CONFIG_SCHEMA,
    state: null,
    alarms: [],
    counters: [],
    thresholds: [],
    suppressProperty: null,
    connection: { lostAfterFailures: DEFAULT_LOST_AFTER_FAILURES },
    isa95: { site: null, levels: {} },
  };
}

/** The rules the detector applies to a package — the package override when present, else the server rules */
export function effectiveStateRules(server: Pick<ServerIntegrationConfig, 'stateRules'>, pkg?: Pick<PackageIntegrationConfig, 'state'> | null): StateRules {
  return pkg?.state?.rules ?? server.stateRules;
}

/**
 * Canonical text of a rule set — the input of `ruleSetHash` (`sha256:` + hex of this string, hashed in the API, since
 * hashing needs `node:crypto`). Two rule sets that judge every value the same give the same text: words are compared
 * normalised, so they are normalised, de-duplicated and sorted here; the state order is fixed.
 */
export function ruleSetHashInput(rules: StateRules): string {
  const canonical = MACHINE_STATES.map((state) => [state, [...new Set(rules[state].map(normalizeStateWord).filter((w) => w !== ''))].sort()]);
  return JSON.stringify(canonical);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ConfigError {
  path: string;
  message: string;
}
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ConfigError[] };

const LIMITS = { name: 200, list: 100, words: 200, shifts: 24, id: 64, levels: 1000 } as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX12 = /^[0-9a-f]{12}$/;

/** Collects errors while walking one input — every problem is reported at once, not only the first */
class Walker {
  readonly errors: ConfigError[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path: path === '' ? '/' : path, message });
  }

  object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, tr('객체여야 합니다.'));
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) this.fail(`${path}/${escapePointer(key)}`, tr('알 수 없는 항목입니다.'));
    }
    return record;
  }

  required(record: Record<string, unknown>, key: string, path: string): unknown {
    if (record[key] === undefined) this.fail(`${path}/${key}`, tr('필수 항목입니다.'));
    return record[key];
  }

  text(value: unknown, path: string, max: number = LIMITS.name): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(path, tr('비어 있지 않은 문자열이어야 합니다.'));
      return undefined;
    }
    if (value.length > max) {
      this.fail(path, fill(tr('{0}자 이하여야 합니다.'), { 0: max }));
      return undefined;
    }
    return value;
  }

  /** Optional text — undefined and null both mean "not set" */
  optionalText(value: unknown, path: string, max: number = LIMITS.name): string | null {
    if (value === undefined || value === null) return null;
    return this.text(value, path, max) ?? null;
  }

  integer(value: unknown, path: string, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(path, fill(tr('{0}~{1} 사이의 정수여야 합니다.'), { 0: min, 1: max }));
      return undefined;
    }
    return value;
  }

  finite(value: unknown, path: string): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, tr('유한한 숫자여야 합니다.'));
      return undefined;
    }
    return value;
  }

  positiveOrNull(value: unknown, path: string, integer: boolean): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      this.fail(path, integer ? tr('0보다 큰 정수여야 합니다.') : tr('0보다 큰 숫자여야 합니다.'));
      return null;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
      this.fail(path, fill(tr('다음 중 하나여야 합니다: {0}'), { 0: options.join(', ') }));
      return undefined;
    }
    return value as T;
  }

  array(value: unknown, path: string, max: number): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.fail(path, tr('배열이어야 합니다.'));
      return undefined;
    }
    if (value.length > max) {
      this.fail(path, fill(tr('항목은 {0}개 이하여야 합니다.'), { 0: max }));
      return undefined;
    }
    return value;
  }

  textList(value: unknown, path: string, max: number): string[] {
    const items = this.array(value, path, max);
    if (!items) return [];
    const out: string[] = [];
    items.forEach((item, index) => {
      const text = this.text(item, `${path}/${index}`);
      if (text !== undefined) out.push(text);
    });
    return out;
  }

  /** Ids unique within one list, matching ID_PATTERN */
  id(value: unknown, path: string, seen: Set<string>): string | undefined {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      this.fail(path, tr('ID는 영문자 또는 숫자로 시작하고 영문자, 숫자, 점, 밑줄, 하이픈만 쓸 수 있습니다(64자 이하).'));
      return undefined;
    }
    if (seen.has(value)) {
      this.fail(path, fill(tr('같은 ID가 이미 있습니다: {0}'), { 0: value }));
      return undefined;
    }
    seen.add(value);
    return value;
  }

  stateRules(value: unknown, path: string): StateRules | undefined {
    const record = this.object(value, path, MACHINE_STATES);
    if (!record) return undefined;
    const rules = {} as Record<MachineState, string[]>;
    for (const state of MACHINE_STATES) {
      rules[state] = record[state] === undefined ? (this.required(record, state, path), []) : this.textList(record[state], `${path}/${state}`, LIMITS.words);
    }
    // A word in two states would be decided by match order alone — make the person resolve it instead
    const owner = new Map<string, MachineState>();
    for (const state of MACHINE_STATES) {
      for (const word of rules[state]) {
        const key = normalizeStateWord(word);
        const first = owner.get(key);
        if (first !== undefined && first !== state) {
          this.fail(`${path}/${state}`, fill(tr('같은 값이 두 상태에 들어 있습니다: {0} ({1}, {2})'), { 0: word, 1: first, 2: state }));
        } else owner.set(key, state);
      }
    }
    return rules;
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function copyRules(rules: StateRules): StateRules {
  return { run: [...rules.run], stop: [...rules.stop], alarm: [...rules.alarm], off: [...rules.off] };
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function done<T>(walker: Walker, value: T): ParseResult<T> {
  return walker.errors.length === 0 ? { ok: true, value } : { ok: false, errors: walker.errors };
}

const SERVER_KEYS = ['schema', 'instanceId', 'stateRules', 'timezone', 'dayStartHour', 'shifts'] as const;

export function parseServerIntegrationConfig(input: unknown): ParseResult<ServerIntegrationConfig> {
  const w = new Walker();
  const record = w.object(input, '', SERVER_KEYS);
  if (!record) return done(w, defaultServerIntegrationConfig());
  const value = defaultServerIntegrationConfig();
  if (record.schema !== SERVER_CONFIG_SCHEMA) w.fail('/schema', fill(tr('"{0}"이어야 합니다.'), { 0: SERVER_CONFIG_SCHEMA }));
  if (record.instanceId !== undefined) {
    if (typeof record.instanceId !== 'string' || !HEX12.test(record.instanceId)) w.fail('/instanceId', tr('12자리 16진수(소문자)여야 합니다.'));
    else value.instanceId = record.instanceId;
  }
  if (record.stateRules !== undefined) value.stateRules = w.stateRules(record.stateRules, '/stateRules') ?? value.stateRules;
  if (record.timezone !== undefined) {
    const zone = w.text(record.timezone, '/timezone', 64);
    if (zone !== undefined && !isValidTimeZone(zone)) w.fail('/timezone', fill(tr('알 수 없는 시간대입니다: {0}'), { 0: zone }));
    else if (zone !== undefined) value.timezone = zone;
  }
  if (record.dayStartHour !== undefined) value.dayStartHour = w.integer(record.dayStartHour, '/dayStartHour', 0, 23) ?? value.dayStartHour;
  if (record.shifts !== undefined) {
    const names = new Set<string>();
    value.shifts = [];
    (w.array(record.shifts, '/shifts', LIMITS.shifts) ?? []).forEach((item, index) => {
      const path = `/shifts/${index}`;
      const shift = w.object(item, path, ['name', 'start', 'end']);
      if (!shift) return;
      const name = w.text(w.required(shift, 'name', path), `${path}/name`, 40);
      const start = parseHhmm(w, w.required(shift, 'start', path), `${path}/start`);
      const end = parseHhmm(w, w.required(shift, 'end', path), `${path}/end`);
      if (name !== undefined && names.has(name)) w.fail(`${path}/name`, fill(tr('같은 이름이 이미 있습니다: {0}'), { 0: name }));
      if (name !== undefined) names.add(name);
      if (start !== undefined && end !== undefined && start === end) w.fail(`${path}/end`, tr('시작 시각과 끝 시각이 같습니다.'));
      if (name !== undefined && start !== undefined && end !== undefined) value.shifts.push({ name, start, end });
    });
  }
  return done(w, value);
}

function parseHhmm(w: Walker, value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !HHMM.test(value)) {
    w.fail(path, tr('시각은 HH:MM 형식(00:00~23:59)이어야 합니다.'));
    return undefined;
  }
  return value;
}

const PACKAGE_KEYS = ['schema', 'state', 'alarms', 'counters', 'thresholds', 'suppressProperty', 'connection', 'isa95'] as const;
const ALARM_KEYS = ['id', 'property', 'activeWhen', 'codeProperty', 'textProperty', 'severity', 'raiseSamples', 'clearSamples', 'maintenanceIds'] as const;
const COUNTER_KEYS = ['id', 'property', 'kind', 'unit', 'max', 'maxRatePerHour'] as const;
const THRESHOLD_KEYS = ['id', 'property', 'direction', 'limit', 'hysteresis', 'unit', 'severity', 'raiseSamples', 'clearSamples'] as const;

/** Debounce counts — how many consecutive cycles confirm a raise or a clear */
function samples(w: Walker, value: unknown, path: string): number {
  return value === undefined ? 1 : (w.integer(value, path, 1, 100) ?? 1);
}

export function parsePackageIntegrationConfig(input: unknown): ParseResult<PackageIntegrationConfig> {
  const w = new Walker();
  const record = w.object(input, '', PACKAGE_KEYS);
  const value = defaultPackageIntegrationConfig();
  if (!record) return done(w, value);
  if (record.schema !== PACKAGE_CONFIG_SCHEMA) w.fail('/schema', fill(tr('"{0}"이어야 합니다.'), { 0: PACKAGE_CONFIG_SCHEMA }));

  if (record.state !== undefined && record.state !== null) {
    const state = w.object(record.state, '/state', ['property', 'interfaceName', 'rules']);
    if (state) {
      const property = w.text(w.required(state, 'property', '/state'), '/state/property');
      const interfaceName = w.optionalText(state.interfaceName, '/state/interfaceName');
      const rules = state.rules === undefined || state.rules === null ? null : (w.stateRules(state.rules, '/state/rules') ?? null);
      if (property !== undefined) value.state = { property, interfaceName, rules };
    }
  }

  if (record.alarms !== undefined) {
    const ids = new Set<string>();
    (w.array(record.alarms, '/alarms', LIMITS.list) ?? []).forEach((item, index) => {
      const path = `/alarms/${index}`;
      const rule = w.object(item, path, ALARM_KEYS);
      if (!rule) return;
      const id = w.id(w.required(rule, 'id', path), `${path}/id`, ids);
      const property = w.text(w.required(rule, 'property', path), `${path}/property`);
      const activeWhen = parseActiveWhen(w, rule.activeWhen, `${path}/activeWhen`);
      const parsed: Omit<AlarmRule, 'id' | 'property'> = {
        activeWhen: activeWhen ?? 'truthy',
        codeProperty: w.optionalText(rule.codeProperty, `${path}/codeProperty`),
        textProperty: w.optionalText(rule.textProperty, `${path}/textProperty`),
        severity: w.optionalText(rule.severity, `${path}/severity`, 40),
        raiseSamples: samples(w, rule.raiseSamples, `${path}/raiseSamples`),
        clearSamples: samples(w, rule.clearSamples, `${path}/clearSamples`),
        maintenanceIds: rule.maintenanceIds === undefined ? [] : w.textList(rule.maintenanceIds, `${path}/maintenanceIds`, LIMITS.list),
      };
      if (id !== undefined && property !== undefined && activeWhen !== undefined) value.alarms.push({ id, property, ...parsed });
    });
  }

  if (record.counters !== undefined) {
    const ids = new Set<string>();
    (w.array(record.counters, '/counters', LIMITS.list) ?? []).forEach((item, index) => {
      const path = `/counters/${index}`;
      const rule = w.object(item, path, COUNTER_KEYS);
      if (!rule) return;
      const rawId = w.required(rule, 'id', path);
      if (rawId === RESERVED_COUNTER_ID) {
        w.fail(`${path}/id`, fill(tr('"{0}"은(는) 예약된 ID입니다.'), { 0: RESERVED_COUNTER_ID }));
        return;
      }
      const id = w.id(rawId, `${path}/id`, ids);
      const property = w.text(w.required(rule, 'property', path), `${path}/property`);
      const kind = rule.kind === undefined ? 'other' : w.oneOf(rule.kind, `${path}/kind`, COUNTER_KINDS);
      const unit = w.optionalText(rule.unit, `${path}/unit`, 40);
      const max = w.positiveOrNull(rule.max, `${path}/max`, true);
      const maxRatePerHour = w.positiveOrNull(rule.maxRatePerHour, `${path}/maxRatePerHour`, false);
      if (id !== undefined && property !== undefined && kind !== undefined) value.counters.push({ id, property, kind, unit, max, maxRatePerHour });
    });
  }

  if (record.thresholds !== undefined) {
    const ids = new Set<string>();
    (w.array(record.thresholds, '/thresholds', LIMITS.list) ?? []).forEach((item, index) => {
      const path = `/thresholds/${index}`;
      const rule = w.object(item, path, THRESHOLD_KEYS);
      if (!rule) return;
      const id = w.id(w.required(rule, 'id', path), `${path}/id`, ids);
      const property = w.text(w.required(rule, 'property', path), `${path}/property`);
      const direction = w.oneOf<ThresholdDirection>(w.required(rule, 'direction', path), `${path}/direction`, ['above', 'below']);
      const limit = w.finite(w.required(rule, 'limit', path), `${path}/limit`);
      let hysteresis = 0;
      if (rule.hysteresis !== undefined) {
        const h = w.finite(rule.hysteresis, `${path}/hysteresis`);
        if (h !== undefined && h < 0) w.fail(`${path}/hysteresis`, tr('0 이상의 숫자여야 합니다.'));
        else if (h !== undefined) hysteresis = h;
      }
      const rest = {
        unit: w.optionalText(rule.unit, `${path}/unit`, 40),
        severity: w.optionalText(rule.severity, `${path}/severity`, 40),
        raiseSamples: samples(w, rule.raiseSamples, `${path}/raiseSamples`),
        clearSamples: samples(w, rule.clearSamples, `${path}/clearSamples`),
      };
      if (id !== undefined && property !== undefined && direction !== undefined && limit !== undefined) {
        value.thresholds.push({ id, property, direction, limit, hysteresis, ...rest });
      }
    });
  }

  value.suppressProperty = w.optionalText(record.suppressProperty, '/suppressProperty');

  if (record.connection !== undefined) {
    const connection = w.object(record.connection, '/connection', ['lostAfterFailures']);
    if (connection?.lostAfterFailures !== undefined) {
      value.connection.lostAfterFailures = w.integer(connection.lostAfterFailures, '/connection/lostAfterFailures', 1, 100) ?? DEFAULT_LOST_AFTER_FAILURES;
    }
  }

  if (record.isa95 !== undefined) {
    const isa95 = w.object(record.isa95, '/isa95', ['site', 'levels']);
    if (isa95) {
      value.isa95.site = w.optionalText(isa95.site, '/isa95/site');
      if (isa95.levels !== undefined) {
        const levels = w.object(isa95.levels, '/isa95/levels', Object.keys(isa95.levels ?? {}));
        if (levels) {
          const entries = Object.entries(levels);
          if (entries.length > LIMITS.levels) w.fail('/isa95/levels', fill(tr('항목은 {0}개 이하여야 합니다.'), { 0: LIMITS.levels }));
          else {
            for (const [nodePath, level] of entries) {
              const path = `/isa95/levels/${escapePointer(nodePath)}`;
              if (nodePath.trim() === '') {
                w.fail(path, tr('노드 경로가 비어 있습니다.'));
                continue;
              }
              const parsed = w.oneOf(level, path, ISA95_LEVELS);
              if (parsed !== undefined) value.isa95.levels[nodePath] = parsed;
            }
          }
        }
      }
    }
  }
  return done(w, value);
}

function parseActiveWhen(w: Walker, value: unknown, path: string): AlarmActiveWhen | undefined {
  if (value === undefined || value === 'truthy') return 'truthy';
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = w.object(value, path, ['equals']);
    if (!record) return undefined;
    const equals = w.textList(w.required(record, 'equals', path), `${path}/equals`, LIMITS.list);
    if (equals.length === 0) {
      if (record.equals !== undefined) w.fail(`${path}/equals`, tr('값이 하나 이상 있어야 합니다.'));
      return undefined;
    }
    return { equals };
  }
  w.fail(path, tr('"truthy" 또는 equals 목록이어야 합니다.'));
  return undefined;
}
