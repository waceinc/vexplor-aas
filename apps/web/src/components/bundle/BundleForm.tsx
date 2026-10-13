/**
 * 레퍼런스 번들 — 내보내기 양식(번들 · 제목 · 버전 · 증빙 수준 · 증빙 기간)과 내보내기 단추.
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import type { BundleView } from '../../api.js';
import { fill, tr } from '../../i18n.js';

interface Props {
  view: BundleView | undefined;
  busy: boolean;
  readyCount: number;
  code: string;
  setCode: (code: string) => void;
  title: string;
  setTitle: (title: string) => void;
  category: string;
  version: string;
  setVersion: (version: string) => void;
  evidenceLevel: string;
  setEvidenceLevel: (level: string) => void;
  evidenceMinutes: string;
  setEvidenceMinutes: (minutes: string) => void;
  onExport: () => Promise<void>;
}

export function BundleForm({ view, busy, readyCount, code, setCode, title, setTitle, category, version, setVersion, evidenceLevel, setEvidenceLevel, evidenceMinutes, setEvidenceMinutes, onExport }: Props): React.JSX.Element {
  const evidence = view?.evidence;
  return (
    <div className="bundle-form">
      <label>
        {tr('번들')}
        <select value={code} onChange={(event) => setCode(event.target.value)}>
          {Object.entries(view?.categories ?? { RB01: '' }).map(([key, name]) => (
            <option key={key} value={key}>
              {key} {name}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        {tr('제목')}
        <input value={title} placeholder={category} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        {tr('버전')}
        <input className="narrow" value={version} onChange={(event) => setVersion(event.target.value)} />
      </label>
      <label title={tr('수집 기록이 어디서 왔는지 — 기록서·README·manifest에 찍힙니다')}>
        {tr('증빙 수준')}
        <select value={evidenceLevel} onChange={(event) => setEvidenceLevel(event.target.value)}>
          {/* <option> 안에는 글자만 둔다 — 화면 요소를 넣으면 브라우저가 글자로 읽지 못한다 */}
          <option value="auto">
            {fill(tr('자동 ({0})'), {
              0: evidence?.suggested ?? (evidence?.sources.length ? null : evidence?.carried?.level) ?? tr('미지정'),
            })}
          </option>
          <option value="A">{tr('A 현장 적용')}</option>
          <option value="B">{tr('B 실장비 재현')}</option>
          <option value="C">{tr('C 시뮬레이션')}</option>
          <option value="none">{tr('비움')}</option>
        </select>
      </label>
      <label title={tr('어느 기간의 수집값을 실을지 — 시험 중 쌓인 값을 빼고 싶을 때')}>
        {tr('증빙 기간')}
        <select value={evidenceMinutes} onChange={(event) => setEvidenceMinutes(event.target.value)}>
          <option value="">{tr('전부')}</option>
          <option value="10">{tr('최근 10분')}</option>
          <option value="30">{tr('최근 30분')}</option>
          <option value="60">{tr('최근 1시간')}</option>
          <option value="1440">{tr('최근 24시간')}</option>
        </select>
      </label>
      <button
        className="primary"
        disabled={busy || !view || readyCount === 0}
        onClick={() => void onExport()}
        title={tr('공정 구성 + 설비 AASX + manifest(SHA256) + 폴더 골격을 ZIP 하나로 받습니다')}
      >
        {busy ? tr('만드는 중…') : tr('번들 내보내기 (.zip)')}
      </button>
    </div>
  );
}
