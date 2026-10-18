/**
 * Collection pane — one connection (interface) — name · protocol · connection state · address · latest value and time per item.
 * Extracted from components/Collection.tsx (2026-10-13 componentization) — markup · comments · judgements moved verbatim at the time.
 */
import type { AidInterfaceView, CollectedValueView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { localTime } from '../../model.js';
import { T } from '../T.js';
import { displayValue, shortReason } from './helpers.js';
import { ageLabel, arrivedAt, freshnessOf, freshWindowMs, tallyFreshness } from './freshness.js';
import { hasUserInfo, maskedEndpoint, statedPollingMs } from '../aid/protocol.js';
import type { ConnectionStatus } from './status.js';

interface Props {
  descriptor: AidInterfaceView;
  status: ConnectionStatus;
  latest: Map<string, CollectedValueView>;
  waitingTags: Set<string>;
  failedTags: Map<string, string>;
  /** Current time (ms) — changes every few seconds so "N min ago" and the stale judgement follow automatically */
  nowMs: number;
  /** Values that arrived within this window count as receiving (freshness.ts) */
  windowMs: number;
}

export function InterfaceCard({ descriptor, status, latest, waitingTags, failedTags, nowMs, windowMs: serverWindowMs }: Props): React.JSX.Element {
  // A link that states a slow read period (2.8.0) keeps "receiving" for three of its periods, not the server's window
  const stated = statedPollingMs(descriptor.properties);
  const windowMs = stated === undefined ? serverWindowMs : Math.max(serverWindowMs, freshWindowMs(stated));
  // Freshness per item — the header total and the row markers use the same judgement
  const fresh = new Map(
    descriptor.properties.map((property) => [property.name, freshnessOf(latest.get(`${descriptor.name}/${property.name}`), nowMs, windowMs)]),
  );
  const sum = tallyFreshness([...fresh.values()].map((f) => f.kind));
  return (
    <div className="interface">
      <div className="interface-head">
        <b>{descriptor.title ?? descriptor.name}</b>
        <span className="chip">{descriptor.protocol}</span>
        {/* Do not distinguish by color alone — dot + text */}
        <span className={`conn ${status.kind}`} title={tr('마지막 수집 시도의 결과입니다')}>
          <span className="dot" aria-hidden="true" />
          {status.label}
        </span>
        {/* Value freshness totals — shows what has dropped without scanning the table. Not by color alone (written as text) */}
        <span
          className="fresh-sum"
          title={fill(tr('받는 중 = {0}분 안에 들어온 값 · 끊김 = 마지막 값은 있으나 그 뒤로 안 들어옴 · 값 없음 = 한 번도 안 들어옴'), { 0: Math.round(windowMs / 60_000) })}
        >
          <span className="fresh live">{fill(tr('받는 중 {0}'), { 0: sum.live })}</span>
          {sum.stale > 0 && <span className="fresh stale">{fill(tr('끊김 {0}'), { 0: sum.stale })}</span>}
          {sum.none > 0 && <span className="fresh none">{fill(tr('값 없음 {0}'), { 0: sum.none })}</span>}
        </span>
      </div>
      {/* The password never shows — and the link it is in is left out of the remote collector list (2.8.0, linter AID-1) */}
      <div className="mono base">{descriptor.base ? maskedEndpoint(descriptor.base) : tr('주소 없음')}</div>
      {descriptor.base && hasUserInfo(descriptor.base) && (
        <p className="note warn">{tr('주소에 사용자 이름 · 암호가 들어 있습니다 — 원격 수집기 목록에서 빠집니다. 「연결수정」에서 떼고 「로그인 필요」를 켜십시오.')}</p>
      )}

      <table>
        <thead>
          <tr>
            <th>{tr('항목')}</th>
            <th className="value-col">{tr('최근 값')}</th>
            <th className="time-col">{tr('시각')}</th>
          </tr>
        </thead>
        <tbody>
          {descriptor.properties.map((property) => {
            const key = `${descriptor.name}/${property.name}`;
            const stored = latest.get(key);
            // A stored failure (2.8.0 — remote collector, automatic collection) shows like a failure of the run just made
            const value = stored?.error === undefined ? stored : undefined;
            const failed = failedTags.get(key) ?? stored?.error;
            const waiting = waitingTags.has(key);
            const badValue = value?.quality !== undefined && value.quality !== 'Good';
            return (
              <tr key={property.name}>
                <td>
                  <span className="tag-name">{property.name}</span>
                  {property.unit && <span className="unit"> {property.unit}</span>}
                  {/* The address goes on its own line — if the value gets pushed out, you cannot tell whether collection works */}
                  <div className="mono address" title={property.href ?? ''}>
                    {property.href ?? tr('주소 없음')}
                  </div>
                </td>
                <td className={`value-col${badValue || (!value && failed !== undefined) ? ' bad' : ''}`}>
                  {value ? (
                    <>
                      {displayValue(value)}
                      {badValue && <span className="unit"> {value.quality}</span>}
                    </>
                  ) : failed !== undefined ? (
                    /* A read attempt that failed — show the reason (StatusCode) briefly alongside. When it lived only in title,
                       it appeared only on hover, so people passed by without reading "why" (measured in a beginner demo) */
                    <span title={failed}><T k={'읽기 실패{0}'} v={[<span className="dim"> — {shortReason(failed)}</span>]} />
                    </span>
                  ) : waiting ? (
                    /*
                     * Important: "awaiting value" — not a failure. No color (dimmed text); **it says so in words**:
                     *    painted yellow it would be indistinguishable from a real failure on the next row
                     */
                    <span
                      className="waiting"
                      title={tr('설비에 붙어 읽었으나 아직 값이 올라오지 않았습니다. 고장이 아닙니다')}
                    >
                      {tr('값 대기')}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td
                  className={`unit time-col${fresh.get(property.name)?.kind === 'stale' ? ' stale' : ''}`}
                  {...(stored
                    ? { title: fill(tr('받은 시각 {0} · 장비 시각 {1}'), { 0: localTime(arrivedAt(stored)), 1: localTime(stored.observedAt) }) }
                    : {})}
                >
                  {stored && fresh.get(property.name)?.ageMs !== undefined ? (
                    <>
                      {fresh.get(property.name)?.kind === 'stale' && <span className="fresh stale">{tr('끊김')}</span>}{' '}
                      {ageLabel(fresh.get(property.name)!.ageMs!)}
                    </>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
