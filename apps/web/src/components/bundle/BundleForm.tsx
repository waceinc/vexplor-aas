/**
 * Reference bundle — export form (bundle · title · version · evidence level · evidence period) and the export button.
 * Extracted from components/BundlePanel.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 */
import type { BundleView } from '../../api.js';
import { fill, tr, trServerValue } from '../../i18n.js';

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
              {key} {trServerValue(name)}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        {tr('제목')}
        <input
          value={title}
          // If left empty, the category name (Korean — the name set by the program) becomes the title. On the English screen the meaning is added
          placeholder={trServerValue(category) === category ? category : `${category} — ${trServerValue(category)}`}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        {tr('버전')}
        <input className="narrow" value={version} onChange={(event) => setVersion(event.target.value)} />
      </label>
      <label title={tr('수집 기록이 어디서 왔는지 — 기록서·README·manifest에 찍힙니다')}>
        {tr('증빙 수준')}
        <select value={evidenceLevel} onChange={(event) => setEvidenceLevel(event.target.value)}>
          {/* Only text inside <option> — if screen elements are put in, the browser cannot read them as text */}
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
        title={tr('공정 구성 + 설비 AASX + manifest(SHA256) + 폴더 구조를 ZIP 하나로 받습니다')}
      >
        {busy ? tr('만드는 중…') : tr('번들 내보내기 (.zip)')}
      </button>
    </div>
  );
}
