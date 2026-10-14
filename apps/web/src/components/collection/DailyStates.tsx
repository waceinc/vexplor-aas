/**
 * Daily state — one row per machine; a 24-hour bar from the day start painted with running · stopped · alarm · power off · no data.
 *
 * Rules, day start and the chosen state tag come from the **server** (integration design §6.1, D3): the same rules judge
 * this bar and the state events sent to MES, so the bar and the events agree. The bar is still computed here, with the
 * same core functions (`@aas/core` states) over the same stored values. Times are based on reception time.
 *
 * Important: graceful fallback — a server without the integration routes (older version) answers 404. Then the screen
 *    works exactly as before: rules in this browser only (localStorage `aas.stateRules`), day start 08:00.
 * Important: server rules are changed by admins only (PUT /integrations/config). Others see them read-only with a
 *    note — editing them in one browser would make this bar disagree with the events again.
 * Important: rules saved in a browser before the server held any (revision 0) are offered to an admin once
 *    ("move to the server"); after success the browser copy is removed so it cannot drift again.
 */
import { DEFAULT_DAY_START_HOUR, defaultPackageIntegrationConfig, effectiveStateRules, parsePackageIntegrationConfig, type PackageIntegrationConfig, type ServerIntegrationConfig } from '@aas/core';
import { useEffect, useState } from 'react';
import { api, type AuthState } from '../../api.js';
import { isStale } from '../../api/integration.js';
import { fill, locale, tr } from '../../i18n.js';
import { integrationAccess } from '../integrations/common.js';
import { DEFAULT_STATE_RULES, dayWindow, normalizeState, parseRuleList, pickStateTag, stateTimeline, stateTotals, type BarState, type Segment, type StateRules } from './states.js';

export interface StateRow {
  packageId: string;
  name: string;
}

interface Props {
  rows: readonly StateRow[];
  /** Maximum time one value lasts — same as the freshness window (no value for longer than this = no data) */
  holdMs: number;
  /**
   * A value that changes whenever new collected values arrive — when it changes the bar is re-read. Without it the bar was read only once,
   * so just-collected values did not show on the bar (measured on screen, 2026-10-14)
   */
  version?: string;
  t: (text: string) => string;
}

const RULES_KEY = 'aas.stateRules';
function label(state: BarState): string {
  if (state === 'run') return tr('가동');
  if (state === 'stop') return tr('정지');
  if (state === 'alarm') return tr('알람');
  if (state === 'off') return tr('전원 꺼짐');
  if (state === 'unknown') return tr('판정 못함');
  return tr('데이터 없음');
}

/** Rules saved in this browser by the old screen — undefined when none */
function browserRules(): StateRules | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null') as unknown;
    if (saved && typeof saved === 'object') return { ...DEFAULT_STATE_RULES, ...(saved as Partial<StateRules>) };
  } catch {
    // Browser that cannot use storage — nothing saved
  }
  return undefined;
}

const sameRules = (a: StateRules, b: StateRules): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The date today's day started — yesterday if before the start hour */
function shiftDay(now: Date, startHour: number): Date {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < startHour) day.setDate(day.getDate() - 1);
  return day;
}

export function duration(ms: number): string {
  if (ms > 0 && ms < 60_000) return tr('1분 미만'); // writing "0 min" reads as if it never happened
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? fill(tr('{0}시간 {1}분'), { 0: h, 1: m }) : fill(tr('{0}분'), { 0: m });
}

/** Where the rules come from — `server` (integration config) or `local` (an older server without it) */
type Source = { kind: 'loading' } | { kind: 'local' } | { kind: 'server'; config: ServerIntegrationConfig; revision: number };

export function DailyStates({ rows, holdMs, version = '', t }: Props): React.JSX.Element | null {
  const [source, setSource] = useState<Source>({ kind: 'loading' });
  const [auth, setAuth] = useState<AuthState>();
  const [localRules, setLocalRules] = useState<StateRules>(() => browserRules() ?? DEFAULT_STATE_RULES);
  const [dayOffset, setDayOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [stale, setStale] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    api.integration
      .serverConfig()
      .then((loaded) => alive && setSource({ kind: 'server', config: loaded.value, revision: loaded.revision }))
      // 404 = older server; any other failure also falls back so the bar still draws
      .catch(() => alive && setSource({ kind: 'local' }));
    api
      .authMe()
      .then((next) => alive && setAuth(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [generation]);

  if (rows.length === 0) return null;
  const server = source.kind === 'server' ? source : undefined;
  const access = integrationAccess(auth);
  const rules = server ? server.config.stateRules : localRules;
  const startHour = server ? server.config.dayStartHour : DEFAULT_DAY_START_HOUR;
  const today = shiftDay(new Date(), startHour);
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset);
  const pending = browserRules();
  const offerMove = server !== undefined && server.revision === 0 && access.admin && pending !== undefined && !sameRules(pending, server.config.stateRules);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const saveServer = async (stateRules: StateRules, removeLocal: boolean): Promise<void> => {
    if (!server) return;
    setSaveError(undefined);
    try {
      const next = await api.integration.saveServerConfig({ ...server.config, stateRules }, server.revision);
      setSource({ kind: 'server', config: next.value, revision: next.revision });
      if (removeLocal) {
        try {
          localStorage.removeItem(RULES_KEY);
        } catch {
          // Storage unavailable — nothing to remove
        }
      }
    } catch (caught) {
      if (isStale(caught)) setStale(true);
      else setSaveError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveRules = (next: StateRules): void => {
    if (server) {
      void saveServer(next, false);
      return;
    }
    setLocalRules(next);
    try {
      localStorage.setItem(RULES_KEY, JSON.stringify(next));
    } catch {
      // Even if it cannot be saved, it applies to this screen
    }
  };
  const ticks = [0, 4, 8, 12, 16, 20].map((offset) => `${String((startHour + offset) % 24).padStart(2, '0')}:00`);
  const canEditRules = server ? access.admin : true;

  return (
    <section className="daily-states">
      <div className="daily-head">
        <h4>{t('하루 상태')}</h4>
        <button className="link" aria-label={tr('앞 날')} onClick={() => setDayOffset(dayOffset - 1)}>◀</button>
        <span className="mono">{fill(tr('{0} {1}:00 부터 24시간'), { 0: day.toLocaleDateString(locale()), 1: String(startHour).padStart(2, '0') })}</span>
        <button className="link" aria-label={tr('다음 날')} disabled={dayOffset >= 0} onClick={() => setDayOffset(dayOffset + 1)}>▶</button>
        <span className="spacer" />
        <button className="link" onClick={() => setEditing(!editing)}>{tr('판정 규칙')}</button>
      </div>
      {offerMove && (
        <p className="note warning state-move" role="status">
          {tr('이 브라우저에만 저장된 판정 규칙이 있습니다. 서버로 옮기면 모든 화면과 MES 로 가는 상태 사건이 같은 규칙을 사용합니다.')}{' '}
          <button type="button" onClick={() => void saveServer(pending, true)}>
            {tr('브라우저 규칙을 서버로 옮기기')}
          </button>
        </p>
      )}
      {stale && (
        <p className="note warning" role="alert">
          {tr('다른 곳에서 먼저 규칙을 저장했습니다. 다시 읽은 뒤 고쳐 주십시오.')}{' '}
          <button
            type="button"
            onClick={() => {
              setStale(false);
              setGeneration(generation + 1);
            }}
          >
            {tr('다시 읽기')}
          </button>
        </p>
      )}
      {saveError && <p className="note error" role="alert">{saveError}</p>}
      {editing && (
        <div className="state-rules" key={server ? `server-${server.revision}` : 'local'}>
          <p className="hint">
            {server
              ? tr('값이 이 글자와 같으면 그 상태로 봅니다(쉼표로 나눔, 대소문자 · 공백 무시). 규칙에 없는 값은 「판정 못함」입니다. 서버에 저장되어 모든 화면과 연동 사건이 함께 사용합니다.')
              : tr('값이 이 글자와 같으면 그 상태로 봅니다(쉼표로 나눔, 대소문자 · 공백 무시). 규칙에 없는 값은 「판정 못함」입니다. 이 브라우저에만 남습니다.')}
          </p>
          {server && !canEditRules && <p className="hint">{tr('서버 판정 규칙은 관리자만 바꿀 수 있습니다.')}</p>}
          {(['run', 'stop', 'alarm', 'off'] as const).map((state) => (
            <label key={state}>
              <span className={`state-chip state-${state}`}>{label(state)}</span>
              <input aria-label={fill(tr('{0} 규칙'), { 0: label(state) })} disabled={!canEditRules} defaultValue={rules[state].join(', ')} onBlur={(event) => saveRules({ ...rules, [state]: parseRuleList(event.target.value) })} />
            </label>
          ))}
          {canEditRules && <button className="link" onClick={() => saveRules(DEFAULT_STATE_RULES)}>{tr('기본 규칙으로')}</button>}
        </div>
      )}
      {server && browserZone && browserZone !== server.config.timezone && (
        <p className="hint">{fill(tr('막대는 이 브라우저의 시간대({0})로 그립니다. 서버의 하루 기준 시간대는 {1} 입니다.'), { 0: browserZone, 1: server.config.timezone })}</p>
      )}
      {source.kind !== 'loading' &&
        rows.map((row) => (
          <StateLine
            key={`${row.packageId}-${day.getTime()}-${JSON.stringify(rules)}`}
            row={row}
            day={day}
            startHour={startHour}
            serverRules={server ? rules : undefined}
            localRules={rules}
            canSaveTag={server !== undefined && access.edit}
            holdMs={holdMs}
            version={version}
            ticks={ticks}
          />
        ))}
      <div className="state-legend">
        {(['run', 'stop', 'alarm', 'off', 'unknown', 'none'] as const).map((state) => (
          <span key={state} className={`state-chip state-${state}`}>{label(state)}</span>
        ))}
      </div>
    </section>
  );
}

interface LineProps {
  row: StateRow;
  day: Date;
  startHour: number;
  /** Server rules when the server has integration config — the package's own override (if any) wins over them */
  serverRules: StateRules | undefined;
  localRules: StateRules;
  /** The chosen tag is written to the package config (editors on a server with integration routes) */
  canSaveTag: boolean;
  holdMs: number;
  version: string;
  ticks: readonly string[];
}

function StateLine({ row, day, startHour, serverRules, localRules, canSaveTag, holdMs, version, ticks }: LineProps): React.JSX.Element {
  const [names, setNames] = useState<string[]>();
  const [tag, setTag] = useState<string>();
  const [segments, setSegments] = useState<Segment[]>();
  const [config, setConfig] = useState<{ value: PackageIntegrationConfig | null; revision: number }>();
  const [tagNote, setTagNote] = useState<string>();
  const { start, end } = dayWindow(day, startHour);
  const rules = serverRules ? effectiveStateRules({ stateRules: serverRules }, config?.value ?? null) : localRules;

  useEffect(() => {
    let alive = true;
    // The saved tag comes first; without one (or on an older server) the name-based suggestion is used
    const saved = serverRules
      ? api.integration.packageConfig(row.packageId).then(
          (loaded) => {
            if (alive) setConfig(loaded);
            return loaded.value?.state?.property;
          },
          // No config yet, or an older server (404) — fall back to the suggestion
          () => undefined,
        )
      : Promise.resolve(undefined);
    void Promise.all([api.interfaces(row.packageId), saved])
      .then(([result, savedTag]) => {
        if (!alive) return;
        const list = [...new Set(result.interfaces.flatMap((item) => item.properties.map((property) => property.name)))];
        setNames(list);
        setTag((current) => current ?? savedTag ?? pickStateTag(list));
      })
      .catch(() => alive && setNames([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only "server or local" matters for loading the tag, not the rule words
  }, [row.packageId, serverRules === undefined]);

  useEffect(() => {
    if (!tag) return;
    let alive = true;
    void api
      .valuesBetween(row.packageId, { property: tag, from: new Date(start - holdMs).toISOString(), to: new Date(end).toISOString() })
      .then((result) => {
        if (!alive) return;
        const samples = result.result.map((value) => ({ at: Date.parse(value.receivedAt ?? value.observedAt), state: normalizeState(value, rules) }));
        setSegments(stateTimeline(samples, start, Math.min(end, Date.now()), holdMs));
      })
      .catch(() => alive && setSegments([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rules compared by content: a new object with the same words must not re-read
  }, [row.packageId, tag, start, end, holdMs, JSON.stringify(rules), version]);

  /** Choosing a tag saves it for everyone (the event detector reads the same field); otherwise it is this screen only */
  const chooseTag = async (next: string | undefined): Promise<void> => {
    setTag(next);
    setTagNote(undefined);
    if (!canSaveTag || !next) return;
    const base = config?.value ?? defaultPackageIntegrationConfig();
    const parsed = parsePackageIntegrationConfig({ ...base, state: { property: next, interfaceName: base.state?.interfaceName ?? null, rules: base.state?.rules ?? null } });
    if (!parsed.ok) return setTagNote(parsed.errors[0]?.message);
    try {
      const saved = await api.integration.savePackageConfig(row.packageId, parsed.value, config?.revision ?? 0);
      setConfig(saved);
    } catch {
      setTagNote(tr('상태 태그를 서버에 저장하지 못했습니다 — 이 화면에만 적용됩니다.'));
    }
  };

  const span = end - start;
  const totals = segments ? stateTotals(segments) : undefined;
  return (
    <div className="state-row">
      <div className="state-name">
        <b>{row.name}</b>
        {names && names.length > 0 && (
          <select aria-label={fill(tr('{0} 상태 태그'), { 0: row.name })} value={tag ?? ''} onChange={(event) => void chooseTag(event.target.value || undefined)}>
            <option value="">{tr('상태 태그 고르기')}</option>
            {names.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
        {names && names.length === 0 && <span className="dim">{tr('수집 연결 없음')}</span>}
        {tagNote && <span className="dim">{tagNote}</span>}
      </div>
      {/* Time ticks sit right above the bars — if the tag picker sits in between, ticks and bars read as separate */}
      <div className="state-ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <div className="state-bar" role="img" aria-label={fill(tr('{0} 하루 상태'), { 0: row.name })}>
        {(segments ?? []).map((segment) => (
          <span
            key={segment.from}
            className={`state-seg state-${segment.state}`}
            style={{ left: `${((segment.from - start) / span) * 100}%`, width: `${((segment.to - segment.from) / span) * 100}%` }}
            title={`${new Date(segment.from).toLocaleTimeString(locale())} ~ ${new Date(segment.to).toLocaleTimeString(locale())} · ${label(segment.state)}`}
          />
        ))}
      </div>
      <div className="state-totals dim">
        {!tag ? tr('상태 태그를 고르면 그립니다') : totals ? (['run', 'stop', 'alarm', 'off', 'unknown'] as const).filter((state) => totals[state] > 0).map((state) => `${label(state)} ${duration(totals[state])}`).join(' · ') || tr('이날 받은 값 없음') : tr('읽는 중…')}
      </div>
    </div>
  );
}
