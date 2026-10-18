/**
 * Reference bundle — ⑤ points to check — semanticId reuse, etc. Hovering a row highlights that row in the matrix.
 * Extracted from components/BundlePanel.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
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
              <span className="badge">{finding.severity === 'warning' ? tr('확인') : tr('참고')}</span> {finding.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
