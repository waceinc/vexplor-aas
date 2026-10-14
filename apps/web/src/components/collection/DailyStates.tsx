/**
 * 하루 상태 — 설비마다 한 줄, 교대 시작(08시)부터 24시간 막대에 가동 · 정지 · 알람 · 전원 꺼짐 · 데이터 없음을 칠한다.
 *
 * 상태 태그는 이름으로 고르되(하나만 맞을 때), 못 고르면 사람이 고른다. 값 → 상태 규칙은 「판정 규칙」에서 바꾼다
 * (고객마다 다르다 — 이 브라우저에만 남는다). 계산은 states.ts 가 한다. 시각은 수신 시각 기준이다.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { fill, locale, tr } from '../../i18n.js';
import { DEFAULT_STATE_RULES, dayWindow, normalizeState, parseRuleList, pickStateTag, stateTimeline, stateTotals, type BarState, type Segment, type StateRules } from './states.js';

export interface StateRow {
  packageId: string;
  name: string;
}

interface Props {
  rows: readonly StateRow[];
  /** 값 하나가 이어지는 최대 시간 — 신선도 창과 같다(이 시간 넘게 값이 없으면 데이터 없음) */
  holdMs: number;
  /**
   * 수집값이 새로 들어올 때마다 바뀌는 값 — 바뀌면 막대를 다시 읽는다. 없으면 처음 한 번만 읽어
   * 방금 수집한 값이 막대에 안 나왔다(2026-10-14 화면 실측)
   */
  version?: string;
  t: (text: string) => string;
}

const START_HOUR = 8;
const RULES_KEY = 'aas.stateRules';
function label(state: BarState): string {
  if (state === 'run') return tr('가동');
  if (state === 'stop') return tr('정지');
  if (state === 'alarm') return tr('알람');
  if (state === 'off') return tr('전원 꺼짐');
  if (state === 'unknown') return tr('판정 못함');
  return tr('데이터 없음');
}

function loadRules(): StateRules {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null') as unknown;
    if (saved && typeof saved === 'object') return { ...DEFAULT_STATE_RULES, ...(saved as Partial<StateRules>) };
  } catch {
    // 저장소를 못 쓰는 브라우저 — 기본 규칙으로 간다
  }
  return DEFAULT_STATE_RULES;
}

/** 오늘 교대가 시작한 날 — 08시 전이면 어제 */
function shiftDay(now: Date): Date {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < START_HOUR) day.setDate(day.getDate() - 1);
  return day;
}

export function duration(ms: number): string {
  if (ms > 0 && ms < 60_000) return tr('1분 미만'); // 「0분」이라 쓰면 없었던 것으로 읽힌다
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? fill(tr('{0}시간 {1}분'), { 0: h, 1: m }) : fill(tr('{0}분'), { 0: m });
}

export function DailyStates({ rows, holdMs, version = '', t }: Props): React.JSX.Element | null {
  const [day, setDay] = useState(() => shiftDay(new Date()));
  const [rules, setRules] = useState<StateRules>(loadRules);
  const [editing, setEditing] = useState(false);
  if (rows.length === 0) return null;
  const today = shiftDay(new Date());
  const move = (days: number): void => setDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days));
  const saveRules = (next: StateRules): void => {
    setRules(next);
    try {
      localStorage.setItem(RULES_KEY, JSON.stringify(next));
    } catch {
      // 저장 못 해도 이번 화면에는 적용된다
    }
  };
  const ticks = [0, 4, 8, 12, 16, 20].map((offset) => `${String((START_HOUR + offset) % 24).padStart(2, '0')}:00`);

  return (
    <section className="daily-states">
      <div className="daily-head">
        <h4>{t('하루 상태')}</h4>
        <button className="link" aria-label={tr('앞 날')} onClick={() => move(-1)}>◀</button>
        <span className="mono">{fill(tr('{0} {1}:00 부터 24시간'), { 0: day.toLocaleDateString(locale()), 1: String(START_HOUR).padStart(2, '0') })}</span>
        <button className="link" aria-label={tr('다음 날')} disabled={day.getTime() >= today.getTime()} onClick={() => move(1)}>▶</button>
        <span className="spacer" />
        <button className="link" onClick={() => setEditing(!editing)}>{tr('판정 규칙')}</button>
      </div>
      {editing && (
        <div className="state-rules">
          <p className="hint">{tr('값이 이 글자와 같으면 그 상태로 봅니다(쉼표로 나눔, 대소문자 · 공백 무시). 규칙에 없는 값은 「판정 못함」입니다. 이 브라우저에만 남습니다.')}</p>
          {(['run', 'stop', 'alarm', 'off'] as const).map((state) => (
            <label key={state}>
              <span className={`state-chip state-${state}`}>{label(state)}</span>
              <input aria-label={fill(tr('{0} 규칙'), { 0: label(state) })} defaultValue={rules[state].join(', ')} onBlur={(event) => saveRules({ ...rules, [state]: parseRuleList(event.target.value) })} />
            </label>
          ))}
          <button className="link" onClick={() => saveRules(DEFAULT_STATE_RULES)}>{tr('기본 규칙으로')}</button>
        </div>
      )}
      {rows.map((row) => (
        <StateLine key={`${row.packageId}-${day.getTime()}-${JSON.stringify(rules)}`} row={row} day={day} rules={rules} holdMs={holdMs} version={version} ticks={ticks} />
      ))}
      <div className="state-legend">
        {(['run', 'stop', 'alarm', 'off', 'unknown', 'none'] as const).map((state) => (
          <span key={state} className={`state-chip state-${state}`}>{label(state)}</span>
        ))}
      </div>
    </section>
  );
}

function StateLine({ row, day, rules, holdMs, version, ticks }: { row: StateRow; day: Date; rules: StateRules; holdMs: number; version: string; ticks: readonly string[] }): React.JSX.Element {
  const [names, setNames] = useState<string[]>();
  const [tag, setTag] = useState<string>();
  const [segments, setSegments] = useState<Segment[]>();
  const { start, end } = dayWindow(day, START_HOUR);

  useEffect(() => {
    let alive = true;
    void api
      .interfaces(row.packageId)
      .then((result) => {
        if (!alive) return;
        const list = [...new Set(result.interfaces.flatMap((item) => item.properties.map((property) => property.name)))];
        setNames(list);
        setTag((current) => current ?? pickStateTag(list));
      })
      .catch(() => alive && setNames([]));
    return () => {
      alive = false;
    };
  }, [row.packageId]);

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
  }, [row.packageId, tag, start, end, holdMs, rules, version]);

  const span = end - start;
  const totals = segments ? stateTotals(segments) : undefined;
  return (
    <div className="state-row">
      <div className="state-name">
        <b>{row.name}</b>
        {names && names.length > 0 && (
          <select aria-label={fill(tr('{0} 상태 태그'), { 0: row.name })} value={tag ?? ''} onChange={(event) => setTag(event.target.value || undefined)}>
            <option value="">{tr('상태 태그 고르기')}</option>
            {names.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
        {names && names.length === 0 && <span className="dim">{tr('수집 연결 없음')}</span>}
      </div>
      {/* 시간 눈금은 막대 바로 위에 — 태그 고르는 칸이 사이에 끼면 눈금과 막대가 떨어져 읽힌다 */}
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
