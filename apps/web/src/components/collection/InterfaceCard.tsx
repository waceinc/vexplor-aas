/**
 * 수집 칸 — 연결(인터페이스) 하나 — 이름 · 프로토콜 · 연결 상태 · 주소 · 항목별 최근 값과 시각.
 * components/Collection.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석·판정은 옮기기 전 글자 그대로다.
 */
import type { AidInterfaceView, CollectedValueView } from '../../api.js';
import { tr } from '../../i18n.js';
import { localTime } from '../../model.js';
import { T } from '../T.js';
import { displayValue, shortReason } from './helpers.js';
import type { ConnectionStatus } from './status.js';

interface Props {
  descriptor: AidInterfaceView;
  status: ConnectionStatus;
  latest: Map<string, CollectedValueView>;
  waitingTags: Set<string>;
  failedTags: Map<string, string>;
}

export function InterfaceCard({ descriptor, status, latest, waitingTags, failedTags }: Props): React.JSX.Element {
  return (
    <div className="interface">
      <div className="interface-head">
        <b>{descriptor.title ?? descriptor.name}</b>
        <span className="chip">{descriptor.protocol}</span>
        {/* 색만으로 나누지 않는다 — 점 + 글자 */}
        <span className={`conn ${status.kind}`} title={tr('마지막 수집 시도의 결과입니다')}>
          <span className="dot" aria-hidden="true" />
          {status.label}
        </span>
      </div>
      <div className="mono base">{descriptor.base ?? tr('주소 없음')}</div>

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
            const value = latest.get(key);
            const failed = failedTags.get(key);
            const waiting = waitingTags.has(key);
            const badValue = value?.quality !== undefined && value.quality !== 'Good';
            return (
              <tr key={property.name}>
                <td>
                  <span className="tag-name">{property.name}</span>
                  {property.unit && <span className="unit"> {property.unit}</span>}
                  {/* 주소는 줄로 내려 둔다 — 값이 밀려나면 수집이 되는지 알 수 없다 */}
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
                    /* 읽으러 갔다가 실패한 것 — 사유(StatusCode)를 짧게 같이 쓴다. title에만 두면
                       마우스를 올려야 보여서 「왜」를 못 읽고 지나쳤다(초보자 시연 실측) */
                    <span title={failed}><T k={'읽기 실패{0}'} v={[<span className="dim"> — {shortReason(failed)}</span>]} />
                    </span>
                  ) : waiting ? (
                    /*
                     * 🔴 「값 대기」 — 고장이 아니다. 색을 빼고(흐린 글자) **글자로 말한다**:
                     *    노랑으로 칠하면 옆줄의 진짜 실패와 구별되지 않는다
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
                <td className="unit time-col">{value ? localTime(value.observedAt) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
