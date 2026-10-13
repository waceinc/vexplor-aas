/**
 * 레퍼런스 번들 — ⑤ 확인할 점 — semanticId 재사용 등. 줄에 마우스를 올리면 매트릭스의 그 줄이 강조된다.
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import type { BundleView } from '../../api.js';
import { tr } from '../../i18n.js';

interface Props {
  view: BundleView | undefined;
  setFocus: (semanticId: string | undefined) => void;
}

export function BundleFindings({ view, setFocus }: Props): React.JSX.Element {
  return (
    <>
      <h3>{tr('⑤ 확인할 점')}</h3>
      {(view?.linkage.findings.length ?? 0) === 0 ? (
        <p className="dim">{tr('없음')}</p>
      ) : (
        <ul className="bundle-findings">
          {view!.linkage.findings.map((finding, index) => (
            <li
              key={index}
              className={finding.severity}
              onMouseEnter={() => setFocus(finding.semanticIds[0])}
              onMouseLeave={() => setFocus(undefined)}
            >
              <span className="badge">{finding.severity === 'warning' ? tr('⚠ 확인') : tr('ℹ 참고')}</span> {finding.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
