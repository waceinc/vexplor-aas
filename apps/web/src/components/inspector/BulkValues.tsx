/**
 * 값 한꺼번에 입력 — 서브모델을 고르면 안의 값(Property · MLP · Range)을 표로 입력하고 한 번에 저장한다.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
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
  /** 이 서브모델의 템플릿 요구 수준 — 없으면 「모름」 */
  requirement?: SubmodelRequirement;
  /** 수집 연결(AID)의 항목 이름 — 같은 이름의 칸은 수집으로 채워진다 */
  collectedNames?: ReadonlySet<string>;
  onBulkSaveValues: (node: TreeNode, content: Record<string, unknown>) => void;
  /** CSV 에서 채우기(여러 설비 파일)를 마친 뒤 — 알림을 띄우고 지금 파일을 다시 읽는다. 없으면 단추를 그리지 않는다 */
  onCsvFilled?: (notice: string) => void;
  t: (text: string) => string;
}

export function BulkValues({ node, busy, requirement, collectedNames, onBulkSaveValues, onCsvFilled, t }: Props): React.JSX.Element | null {
  const [csvOpen, setCsvOpen] = useState(false);
  /** 값 표의 편집분 — idShortPath → 새 값. 저장 때 서브모델 JSON에 한꺼번에 얹는다 */
  const [bulk, setBulk] = useState<Record<string, string>>({});
  /** 채울 것(필수 · 수집)만 보기 — 템플릿을 알 때만 켤 수 있다 */
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  // 잎 값들을 모은다 — Property(글), MLP(첫 언어), Range(min~max)
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
      {/* 무엇을 채워야 하나 — 템플릿을 알면 필수 · 수집 · 선택을 센다. 모르면 그 사실을 말한다 */}
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
          // 서브모델 JSON을 복제해 바뀐 값만 얹는다 — 한 번의 PATCH로 저장된다
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

/** 구분 표시 — 색만으로 나누지 않는다(글자로 적는다) */
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
