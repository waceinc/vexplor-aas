/**
 * Reference bundle — ② data linkage — matrix of common operating-data items (items grouped by semanticId × equipment).
 * Split out of components/BundlePanel.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 */
import { useMemo, useState } from 'react';
import type { BundleView, LinkageItemView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';

/** Whether to show only common items — the core of the bundle is "what two or more units have in common" */
type Scope = 'common' | 'all';

const shortSemantic = (id: string): string => {
  const kosmo = /\/ids\/cd\/([^/]+)\//.exec(id)?.[1];
  if (kosmo) return `KOSMO · ${kosmo}`;
  if (/^0173-1#/.test(id)) return `ECLASS · ${id}`;
  return id.length > 40 ? `…${id.slice(-38)}` : id;
};

interface Props {
  view: BundleView | undefined;
  common: number;
  focus: string | undefined;
  setFocus: (semanticId: string | undefined) => void;
}

export function LinkageMatrix({ view, common, focus, setFocus }: Props): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('common');
  const columns = view?.linkage.members ?? [];
  const rows: LinkageItemView[] = useMemo(() => {
    const items = view?.linkage.items ?? [];
    return scope === 'common' ? items.filter((item) => item.coverage >= 2) : items;
  }, [view, scope]);

  /**
   * Equipment → (name → the semanticIds that name uses). Kept to distinguish "absent" from "the same name exists with a different semanticId"
   * — left as a blank cell, an evaluator reads it as "that equipment has no operating state" (measured on FDS)
   */
  const namesByMember = useMemo(() => {
    const index = new Map<string, Map<string, Set<string>>>();
    for (const item of view?.linkage.items ?? []) {
      for (const [member, points] of Object.entries(item.points)) {
        const names = index.get(member) ?? new Map<string, Set<string>>();
        for (const point of points) {
          const ids = names.get(point.idShort) ?? new Set<string>();
          ids.add(item.semanticId);
          names.set(point.idShort, ids);
        }
        index.set(member, names);
      }
    }
    return index;
  }, [view]);

  /** semanticIds with an open point to check — marked ⚠ on the matrix row */
  const flagged = useMemo(() => {
    const map = new Map<string, 'warning' | 'info'>();
    for (const finding of view?.linkage.findings ?? []) {
      for (const id of finding.semanticIds) {
        if (map.get(id) !== 'warning') map.set(id, finding.severity);
      }
    }
    return map;
  }, [view]);

  return (
    <>
      <h3><T k={'② 데이터 연계 — 운전 데이터 공통 항목{0}'} v={[<span className="seg">
          <button
          className={scope === 'common' ? 'on' : ''}
          title={tr('설비 둘 이상이 함께 가진 항목만 봅니다 — 연계에 쓸 수 있는 것들입니다')}
          onClick={() => setScope('common')}
        ><T k={'2대 이상 공통 ({0})'} v={[common]} /></button>
          <button
          className={scope === 'all' ? 'on' : ''}
          title={tr('설비 하나에만 있는 항목까지 모두 봅니다')}
          onClick={() => setScope('all')}
        ><T k={'전부 ({0})'} v={[view?.linkage.items.length ?? 0]} /></button>
        </span>]} />
      </h3>
      <p className="dim small"><T k={'OperationalData의 항목을 <b>semanticId</b>로 묶었습니다. 공정 KPI(OEE·에너지 원단위 등)는 여러 설비의 같은 항목을 모아야 나옵니다. 칸에 마우스를 올리면 그 설비 안의 경로가 보입니다.'} /></p>
      {columns.length === 0 ? (
        <p className="dim small">{tr('열린 설비 파일이 없어 분석할 수 없습니다.')}</p>
      ) : rows.length === 0 && columns.length === 1 ? (
        <p className="dim small"><T k={'설비가 <b>1대</b>라 「공통」 항목이 생길 수 없습니다 — 연계는 설비 2대 이상부터 봅니다(계획서: 공정당 3~5대). 「전부」로 이 설비의 운전 데이터 {0}개를 보십시오.'} v={[view?.linkage.items.length ?? 0]} /></p>
      ) : rows.length === 0 ? (
        <p className="dim small">{tr('2대 이상이 함께 가진 항목이 없습니다 — 「전부」로 설비별 항목을 보십시오.')}</p>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="item-col">{tr('항목 (semanticId)')}</th>
                <th className="cov-col">{tr('보유')}</th>
                {columns.map((name) => (
                  <th key={name} className="member-col" title={name}>
                    <span>{name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const flag = flagged.get(item.semanticId);
                return (
                  <tr
                    key={item.semanticId}
                    className={focus === item.semanticId ? 'focus' : ''}
                    onMouseEnter={() => setFocus(item.semanticId)}
                    onMouseLeave={() => setFocus(undefined)}
                  >
                    <td className="item-col" title={item.semanticId}>
                      {flag && <span className={`flag ${flag}`} title={tr('확인할 점이 있습니다 — 아래 목록')}>{flag === 'warning' ? '⚠' : 'ℹ'}</span>}
                      <b>{item.label}</b>
                      {item.unit && <span className="dim"> [{item.unit}]</span>}
                      {item.names.length > 1 && <span className="warn-text">{' '}<T k={'외 {0}'} v={[item.names.slice(1).join(', ')]} /></span>}
                      <div className="sem">{shortSemantic(item.semanticId)}</div>
                    </td>
                    <td className="cov-col">
                      <div className="cov-bar" aria-label={fill(tr('{0}/{1}대'), { 0: item.coverage, 1: columns.length })}>
                        <span style={{ width: `${(item.coverage / columns.length) * 100}%` }} />
                      </div>
                      <span className="cov-num">
                        {item.coverage}/{columns.length}
                      </span>
                    </td>
                    {columns.map((name) => {
                      const points = item.points[name] ?? [];
                      const other = points.some((p) => p.idShort !== item.label);
                      // Not in this row, but does the same name exist with a different semanticId?
                      const elsewhere =
                        points.length === 0
                          ? [...(namesByMember.get(name)?.get(item.label) ?? [])].filter((id) => id !== item.semanticId)
                          : [];
                      if (elsewhere.length > 0) {
                        return (
                          <td
                            key={name}
                            className="cell split"
                            title={fill(tr('같은 이름 {0}이(가) 다른 semanticId로 있습니다 — 그대로는 모이지 않습니다\n{1}'), { 0: item.label, 1: elsewhere.join('\n') })}
                          >
                            ≠
                          </td>
                        );
                      }
                      return (
                        <td
                          key={name}
                          className={`cell ${points.length > 0 ? (other ? 'has other' : 'has') : ''}`}
                          title={points.map((p) => `${p.path}${p.valueType ? ` (${p.valueType})` : ''}`).join('\n') || tr('없음')}
                        >
                          {points.length > 0 ? (points.length > 1 ? points.length : '●') : ''}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dim small legend">
            <T k={'{0} 같은 이름으로 있음 · {1} 다른 이름으로 있음 · {2} 같은 이름이 <b>다른 semanticId</b>로 있음(그대로는 안 모임) · 숫자는 한 설비 안의 자리 수'} v={[<span className="cell-demo has">●</span>, <span className="cell-demo has other">●</span>, <span className="cell-demo split">≠</span>]} /></p>
        </div>
      )}
    </>
  );
}
