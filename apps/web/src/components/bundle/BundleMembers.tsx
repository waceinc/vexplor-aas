/**
 * Reference bundle — ① composition and readiness — process → equipment cards.
 * Extracted from components/BundlePanel.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 */
import type { BundleMemberView, BundleView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';

/** Group by group path — so the screen reads as "process → equipment" */
function byGroup(members: BundleMemberView[]): [string, BundleMemberView[]][] {
  const groups = new Map<string, BundleMemberView[]>();
  for (const member of members) {
    const key = member.groupPath.join(' › ');
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  return [...groups.entries()];
}

interface Props {
  view: BundleView | undefined;
  members: BundleMemberView[];
  onOpenPackage: (packageId: string) => void;
}

export function BundleMembers({ view, members, onOpenPackage }: Props): React.JSX.Element {
  return (
    <>
      <h3>{tr('① 구성과 준비 상태')}</h3>
      {!view && <p className="dim">{tr('읽는 중…')}</p>}
      {view && members.length === 0 && (
        <p className="dim">{tr('이 공정에 아직 설비가 없습니다. 「무엇으로 이루어졌나」에서 설비를 넣으십시오.')}</p>
      )}
      {byGroup(members).map(([group, list]) => (
        <div key={group || tr('(최상위)')} className="bundle-group">
          <div className="bundle-group-name">▦ {group || view?.process.name}</div>
          <div className="bundle-cards">
            {list.map((member, index) => (
              <button
                key={`${member.name}-${index}`}
                className={`bundle-card ${member.packageId ? (member.lint?.passed ? 'ok' : 'bad') : 'planned'}`}
                disabled={!member.packageId}
                onClick={() => member.packageId && onOpenPackage(member.packageId)}
                title={member.packageId ? tr('눌러서 이 설비 파일을 엽니다') : tr('파일이 없습니다 — 같은 이름으로 설비 파일을 만들면 연결됩니다')}
              >
                <span className="card-name">
                  ⚙ {member.name}
                  {member.bulkCount > 1 && <span className="dim"> ×{member.bulkCount}</span>}
                </span>
                <span className="card-file">{member.fileName ?? tr('파일 없음')}</span>
                {member.demo && (
                  <span className="card-demo" title={tr('수집 연결(AID)이 붙은 시연본입니다 — 정식 번들에는 원본 참조모델을 넣으십시오')}>
                    {tr('⚡ 수집 연결 · 시연본')}
                  </span>
                )}
                {(member.lint?.aasd120 ?? 0) > 0 && (
                  <span
                    className="card-std"
                    title={tr('SubmodelElementList 자식에 idShort — KOSMO는 통과지만 표준 검증기는 오류, BaSyx는 그 하위를 버립니다. 설비 파일을 열어 「자동 고치기」로 지우면 KOSMO에도 영향 없이 풀립니다')}
                  ><T k={'표준 AASd-120 {0}'} v={[member.lint!.aasd120]} />
                  </span>
                )}
                <span className="card-state">
                  {!member.packageId && tr('예정')}
                  {member.lint && (member.lint.passed ? fill(tr('✓ 통과 · 경고 {0}'), { 0: member.lint.warning }) : fill(tr('✕ 위반 {0}'), { 0: member.lint.error }))}
                  {member.version && <span className="dim"> · v{member.version}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
