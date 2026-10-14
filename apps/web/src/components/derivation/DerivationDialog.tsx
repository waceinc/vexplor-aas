/**
 * Type-change review — shows, row by row, what changed in the type file, and pulls only the picked rows down to this unit.
 *
 * Three values side by side: the type value at split time (baseline) · the current type value · this unit's current value.
 * Values changed on site are not overwritten — they show as "Skipped" and cannot be picked. Applying is reverted with "Undo".
 */
import { useState } from 'react';
import type { DerivationChange } from '../../api.js';
import { tr, fill } from '../../i18n.js';
import { Dialog } from '../../ui/Dialog.js';

interface Props {
  sourceName: string;
  changes: readonly DerivationChange[];
  busy: boolean;
  onApply: (keys: string[]) => void;
  onClose: () => void;
}

function kindLabel(kind: DerivationChange['kind']): string {
  if (kind === 'added') return tr('새로 생김');
  if (kind === 'removed') return tr('없어짐');
  return tr('값 바뀜');
}

function reasonLabel(reason: NonNullable<DerivationChange['reason']>): string {
  if (reason === 'parent-missing') return tr('넣을 자리(상위 요소)가 이 호기에 없습니다');
  if (reason === 'submodel-missing') return tr('이 서브모델이 이 호기에 없습니다');
  return tr('이 호기에서 고친 값 — 그대로 둡니다');
}

/** Short value for the table — truncated when long, a dash when absent */
function shown(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

export function DerivationDialog({ sourceName, changes, busy, onApply, onClose }: Props): React.JSX.Element {
  const rows = changes.filter((change) => change.action !== 'same');
  const applicable = rows.filter((change) => change.action === 'apply');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(applicable.map((change) => change.key)));
  const toggle = (key: string): void => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const allPicked = applicable.length > 0 && picked.size === applicable.length;

  return (
    <Dialog className="wide derivation-dialog" label={tr('형식 변경 확인')} onClose={onClose} close={{ text: tr('닫기'), label: tr('형식 변경 확인 닫기') }}>
      <h3>{tr('형식 변경 확인')}</h3>
      <p className="hint">
        {fill(tr('형식 파일 「{0}」에서 바뀐 곳입니다. 고른 줄만 이 호기에 반영합니다 — 이 호기에서 고친 값은 덮지 않습니다.'), { 0: sourceName })}
      </p>
      <table className="derivation-table">
        <thead>
          <tr>
            <th className="pick">
              <input
                type="checkbox"
                aria-label={tr('반영할 줄 모두 고르기')}
                checked={allPicked}
                disabled={applicable.length === 0}
                onChange={() => setPicked(allPicked ? new Set() : new Set(applicable.map((change) => change.key)))}
              />
            </th>
            <th>{tr('위치')}</th>
            <th>{tr('변경')}</th>
            <th>{tr('나눌 때 형식 값')}</th>
            <th>{tr('지금 형식 값')}</th>
            <th>{tr('이 호기 값')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((change) => (
            <tr key={change.key} className={change.action === 'skip' ? 'skip' : undefined}>
              <td className="pick">
                {change.action === 'apply' ? (
                  <input type="checkbox" aria-label={fill(tr('{0} 반영'), { 0: change.path })} checked={picked.has(change.key)} onChange={() => toggle(change.key)} />
                ) : null}
              </td>
              <td className="mono">
                <span className="dim">{change.submodel} /</span> {change.path}
                {change.action === 'skip' && change.reason && <div className="reason">{reasonLabel(change.reason)}</div>}
              </td>
              <td>{kindLabel(change.kind)}</td>
              <td className="mono dim">{shown(change.base)}</td>
              <td className="mono">{shown(change.theirs)}</td>
              <td className="mono">{shown(change.mine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-buttons modal-actions">
        <button className="primary" disabled={busy || picked.size === 0} onClick={() => onApply([...picked])}>
          {fill(tr('고른 {0}줄 반영'), { 0: picked.size })}
        </button>
        <button onClick={onClose} disabled={busy}>
          {tr('취소')}
        </button>
      </div>
    </Dialog>
  );
}
