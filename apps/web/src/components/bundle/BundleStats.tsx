/**
 * 레퍼런스 번들 — 한눈에 — 숫자 다섯(설비 · 사전 점검 · 공통 항목 · 확인할 점 · 실동작 증빙).
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { fill, locale, tr } from '../../i18n.js';
import { T } from '../T.js';

interface Props {
  members: number;
  ready: number;
  planned: number;
  failing: number;
  aasd120: number;
  common: number;
  warnings: number;
  samples: number;
  carried: boolean;
  effectiveLevel: string | null;
}

export function BundleStats({ members, ready, planned, failing, aasd120, common, warnings, samples, carried, effectiveLevel }: Props): React.JSX.Element {
  return (
    <div className="bundle-stats">
      <div className="stat">
        <span className="num">{members}</span>
        <span className="label">{tr('설비')}</span>
        <span className="sub"><T k={'파일 {0}{1}'} v={[ready, planned > 0 && <> · <b className="warn-text"><T k={'예정 {0}'} v={[planned]} /></b></>]} />
        </span>
      </div>
      <div className={`stat ${failing > 0 ? 'bad' : 'ok'}`}>
        <span className="num">{failing === 0 ? '✓' : failing}</span>
        <span className="label">{tr('사전 점검')}</span>
        <span className="sub">
          {failing === 0 ? tr('위반 0건') : tr('위반 있는 설비')}
          {aasd120 > 0 && (
            <>
              {' · '}
              <b className="warn-text" title={tr('KOSMO는 검사하지 않지만 표준 검증기(aas-test-engines)는 오류로 보고, BaSyx는 그 하위를 버립니다')}><T k={'표준 AASd-120 {0}'} v={[aasd120]} />
              </b>
            </>
          )}
        </span>
      </div>
      <div className="stat">
        <span className="num">{common}</span>
        <span className="label">{tr('공통 항목')}</span>
        <span className="sub">{tr('2대 이상이 함께 가진 운전 데이터')}</span>
      </div>
      <div className={`stat ${warnings > 0 ? 'warn' : 'ok'}`}>
        <span className="num">{warnings}</span>
        <span className="label">{tr('확인할 점')}</span>
        <span className="sub">{tr('semanticId 재사용')}</span>
      </div>
      <div className={`stat ${samples > 0 ? 'ok' : 'warn'}`}>
        <span className="num">{samples > 0 ? samples.toLocaleString(locale()) : '—'}</span>
        <span className="label">{tr('실동작 증빙')}</span>
        <span className="sub">
          {samples > 0
            ? fill(tr('{0} · 수준 {1}'), { 0: carried ? tr('이어받은 기록') : tr('수집 기록'), 1: effectiveLevel ?? tr('미지정') })
            : tr('수집 기록 없음')}
        </span>
      </div>
    </div>
  );
}
