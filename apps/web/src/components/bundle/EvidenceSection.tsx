/**
 * 레퍼런스 번들 — ③ 실동작 증빙 — 수집 기록(시연을 못 하는 제출 자리에서 시연을 대신한다).
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import type { BundleView } from '../../api.js';
import { locale, tr } from '../../i18n.js';
import { T } from '../T.js';

type Evidence = NonNullable<BundleView['evidence']>;

interface Props {
  shownSources: Evidence['sources'];
  carried: Evidence['carried'] | undefined;
}

const stamp = (iso: string): string =>
    new Date(iso).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function EvidenceSection({ shownSources, carried }: Props): React.JSX.Element {
  return (
    <>
      <h3>{tr('③ 실동작 증빙 — 수집 기록')}</h3>
      {shownSources.length === 0 ? (
        <div className="evidence-empty">
          <b>{tr('아직 수집 기록이 없습니다.')}</b> {tr('이대로 내보내면 번들에 「실제로 값이 흘렀다」는 증빙이 빠집니다.')}
          <ol>
            <li>{tr('이 번들의 설비를 「호기별로 나누기」로 복제하거나, 시연용 번들(호기 파일)을 함께 엽니다')}</li>
            <li>{tr('가상 PLC(또는 현장 PLC)에 수집 연결을 만들고 몇 분 수집합니다 — 자동 수집이면 더 좋습니다')}</li>
            <li><T k={'다시 이 화면에서 내보내면 <code>05_샘플데이터/수집값_*.csv</code>와 <code>06_검증결과/수집기록.html</code>이 실립니다'} /></li>
          </ol>
        </div>
      ) : (
        <>
          {carried ? (
            <p className="bundle-demo-note"><T k={'↩ 이번에 새로 모은 값은 없습니다 — 번들을 열 때 가져온 <b>이전 번들({0} v{1})의 수집 기록</b>을 그대로 이어받아 싣습니다. 새로 수집하면 통째로 새 기록으로 바뀝니다.'} v={[carried.from.code, carried.from.version]} /></p>
          ) : (
            <p className="dim small"><T k={'번들의 형식 모델은 그대로 두고, <b>그 설비나 거기서 파생된 호기(derivedFrom)</b>에 쌓인 값을 별도 파일로 싣습니다. 현장 주소는 공개 번들이라 가려서 싣습니다.'} /></p>
          )}
          <div className="evidence-list">
            {shownSources.map((source) => (
              <div key={`${source.model}-${source.instance}`} className={`evidence-card ${carried ? 'carried' : ''}`}>
                <div className="ev-head">
                  <b>{source.model}</b>
                  {!source.direct && <span className="dim"> ← {source.instance}</span>}
                  {carried && <span className="ev-carried">{tr('이어받음')}</span>}
                  {source.interfaces.some((i) => i.simulated) && <span className="ev-sim">{tr('시뮬레이션')}</span>}
                </div>
                <div className="ev-num">
                  {source.samples.toLocaleString(locale())}
                  <span><T k={'건 · 항목 {0}'} v={[source.properties]} /></span>
                </div>
                <div className="dim small">
                  {stamp(source.from)} ~ {stamp(source.to)}
                </div>
                {source.interfaces.map((iface) => (
                  <div key={iface.title + iface.endpoint} className="ev-iface">
                    {iface.title} <code>{iface.endpoint}</code>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
