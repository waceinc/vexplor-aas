/**
 * 레퍼런스 번들 — ② 데이터 연계 — 운전 데이터 공통 항목 매트릭스(semanticId 로 묶은 항목 × 설비).
 * components/BundlePanel.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { useMemo, useState } from 'react';
import type { BundleView, LinkageItemView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';

/** 공통 항목만 볼지 — 번들의 핵심은 「2대 이상이 함께 가진 것」이다 */
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
   * 설비 → (이름 → 그 이름이 쓰는 semanticId들). 「없다」와 「같은 이름이 다른 semanticId로 있다」를
   * 구분하려고 둔다 — 빈칸으로 두면 평가자는 「그 설비에는 가동상태가 없다」로 읽는다(FDS 실측)
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

  /** 확인할 점이 걸린 semanticId — 매트릭스 줄에 ⚠ 표시 */
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
                      // 이 줄엔 없지만 같은 이름이 다른 semanticId로 있는가
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
