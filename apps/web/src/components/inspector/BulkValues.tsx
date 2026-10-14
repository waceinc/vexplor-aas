/**
 * Bulk value entry — picking a submodel lets you enter its values (Property · MLP · Range) as a table and save them at once.
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 * Values being typed are this part's state. When moving to another element or when a save changes the content, Inspector changes
 * the key and redraws it, so it returns to the initial values (same result as the old "reset when the fingerprint changes").
 */
import { useState } from 'react';
import { fill, tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';
import { T } from '../T.js';
import type { SubmodelRequirement } from '../../api.js';
import { CsvFillDialog } from '../csvfill/CsvFillDialog.js';
import { applyValue } from './applyValue.js';
import { needOf, type Need } from './need.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  /** Template requirement level of this submodel — "unknown" when absent */
  requirement?: SubmodelRequirement;
  /** Collection-connection (AID) item names — cells with the same name are filled by collection */
  collectedNames?: ReadonlySet<string>;
  onBulkSaveValues: (node: TreeNode, content: Record<string, unknown>) => void;
  /** After fill-from-CSV (several equipment files) finishes — shows a notice and re-reads the current file. No button is drawn when absent */
  onCsvFilled?: (notice: string) => void;
  t: (text: string) => string;
}

export function BulkValues({ node, busy, requirement, collectedNames, onBulkSaveValues, onCsvFilled, t }: Props): React.JSX.Element | null {
  const [csvOpen, setCsvOpen] = useState(false);
  /** Edits in the value table — idShortPath → new value. Applied to the submodel JSON all at once on save */
  const [bulk, setBulk] = useState<Record<string, string>>({});
  /** Show only what to fill (required · collected) — can be turned on only when the template is known */
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  // Collect leaf values — Property (text), MLP (first language), Range (min~max)
  const rows: { path: string; label: string; kind: string; current: string; need: Need }[] = [];
  const collect = (children: readonly TreeNode[], prefix: string): void => {
    for (const child of children) {
      const label = prefix ? `${prefix} › ${child.label}` : child.label;
      const rawChild = child.node as Record<string, unknown>;
      if (child.modelType === 'Property' && child.idShortPath) {
        rows.push({
          path: child.idShortPath,
          label,
          kind: 'Property',
          need: needOf(child.idShortPath, child.label, requirement, collectedNames),
          current: String(rawChild['value'] ?? ''),
        });
      } else if (child.modelType === 'MultiLanguageProperty' && child.idShortPath) {
        const list = (rawChild['value'] as { language: string; text: string }[]) ?? [];
        rows.push({
          path: child.idShortPath,
          label: `${label} (${list[0]?.language ?? 'ko'})`,
          kind: 'MLP',
          need: needOf(child.idShortPath, child.label, requirement, collectedNames),
          current: list[0]?.text ?? '',
        });
      } else if (child.modelType === 'Range' && child.idShortPath) {
        rows.push({
          path: child.idShortPath,
          label: `${label} (min~max)`,
          kind: 'Range',
          need: needOf(child.idShortPath, child.label, requirement, collectedNames),
          current: `${String(rawChild['min'] ?? '')}~${String(rawChild['max'] ?? '')}`,
        });
      }
      collect(child.children, label);
    }
  };
  collect(node.children, '');
  if (rows.length === 0) return null;
  const dirty = Object.keys(bulk).length;
  const count = (need: Need): number => rows.filter((row) => row.need === need).length;
  const emptyRequired = rows.filter((row) => row.need === 'required' && (bulk[row.path] ?? row.current).trim() === '').length;
  const shown = onlyNeeded ? rows.filter((row) => row.need === 'required' || row.need === 'collected') : rows;
  return (
    <div className="bulk-values">
      <p className="pick-title">
        <T k={'값 한꺼번에 입력 ({0}개)'} v={[rows.length]} />
        {onCsvFilled && (
          <button
            className="link csv-open"
            disabled={busy}
            title={tr('설비 대장 CSV 로 이 서브모델을 가진 여러 설비 파일의 값을 한 번에 채웁니다')}
            onClick={() => setCsvOpen(true)}
          >
            {tr('CSV에서 채우기…')}
          </button>
        )}
      </p>
      {csvOpen && onCsvFilled && (
        <CsvFillDialog
          submodel={node.node as Record<string, unknown>}
          busy={busy}
          onClose={() => setCsvOpen(false)}
          onDone={(notice) => {
            setCsvOpen(false);
            onCsvFilled(notice);
          }}
        />
      )}
      {/* What needs filling — if the template is known, count required · collected · optional. If not, say so */}
      {requirement ? (
        <div className="need-summary">
          <span className="need required">{fill(tr('필수 {0}'), { 0: count('required') })}</span>
          {emptyRequired > 0 && <span className="need missing">{fill(tr('빈 필수 {0}'), { 0: emptyRequired })}</span>}
          <span className="need collected">{fill(tr('수집 {0}'), { 0: count('collected') })}</span>
          <span className="need optional">{fill(tr('선택 {0}'), { 0: count('optional') })}</span>
          <label className="check-line" title={tr('필수 항목과 수집으로 채워지는 항목만 보입니다 — 선택 항목은 숨깁니다')}>
            <input type="checkbox" checked={onlyNeeded} onChange={(event) => setOnlyNeeded(event.target.checked)} />
            {tr('채울 것만 보기')}
          </label>
          <span className="dim">{fill(tr('기준: 템플릿 {0}'), { 0: requirement.templateFile ?? requirement.template ?? requirement.semanticId })}</span>
        </div>
      ) : (
        <p className="hint">{tr('이 서브모델의 IDTA 템플릿이 없어 필수 여부를 모릅니다 — 설치 폴더(AAS_TEMPLATES_DIR)에 템플릿을 두면 표시됩니다.')}</p>
      )}
      <table>
        <tbody>
          {shown.map((row) => (
            <tr key={row.path} className={row.need === 'required' && (bulk[row.path] ?? row.current).trim() === '' ? 'missing' : ''}>
              <td className="bulk-need">{needTag(row.need)}</td>
              <td className="bulk-label" title={row.path}>{row.label}</td>
              <td>
                <input
                  value={bulk[row.path] ?? row.current}
                  placeholder={row.kind === 'Range' ? t('예: -10~60') : ''}
                  onChange={(event) =>
                    setBulk((current) => ({ ...current, [row.path]: event.target.value }))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="primary"
        disabled={busy || dirty === 0}
        title={t('표에서 고친 값을 한 번에 반영합니다 — 요소마다 누르지 않아도 됩니다')}
        onClick={() => {
          // Clone the submodel JSON and apply only the changed values — saved with a single PATCH
          const content = JSON.parse(JSON.stringify(node.node)) as Record<string, unknown>;
          for (const [path, value] of Object.entries(bulk)) applyValue(content, path, value);
          onBulkSaveValues(node, content);
          setBulk({});
        }}
      >
        {dirty > 0 ? fill(tr('바뀐 {0}개 저장'), { 0: dirty }) : tr('저장')}
      </button>
    </div>
  );
}

/** Kind label — not distinguished by color alone (written as text) */
function needTag(need: Need): React.JSX.Element | null {
  if (need === 'unknown') return null;
  const text = need === 'required' ? tr('필수') : need === 'collected' ? tr('수집') : tr('선택');
  const title =
    need === 'required'
      ? tr('템플릿이 요구하는 항목 — 비워 두면 템플릿을 어깁니다')
      : need === 'collected'
        ? tr('수집 연결(AID)에 같은 이름이 있어 현장 값으로 채워집니다 — 사람이 적지 않아도 됩니다')
        : tr('템플릿에서 선택 — 비워 두어도 됩니다');
  return <span className={`need ${need}`} title={title}>{text}</span>;
}
