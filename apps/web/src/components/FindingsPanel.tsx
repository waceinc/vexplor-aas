/**
 * 지적 목록 — 이 제품의 존재 이유(기획서 Ⅲ M5 PM 의견).
 *
 * Package Explorer는 규칙 위반을 알려 주지 못한다. 그래서 지적을 곁다리로 두지 않고
 * 트리와 나란한 한 칸으로 세웠다. 지적을 누르면 그 요소가 트리에서 열린다.
 *
 * 🔴 **같은 규칙은 묶는다.** AASd-120 하나가 8건이면 같은 설명이 8번 반복돼
 *    화면이 온통 글자가 된다 — 설명·조치·정책은 묶음에 한 번만 쓰고,
 *    대상은 한 줄씩 나열한다. 개별 대상을 누르면 그 요소로 간다(전과 같다).
 */
import type { Finding } from '../model.js';
import { severityRank } from '../model.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  findings: Finding[];
  skipped?: { ruleId: string; reason: string }[];
  onSelect: (finding: Finding) => void;
  activePointer?: string;
}

interface Group {
  ruleId: string;
  severity: Finding['severity'];
  fixable: boolean;
  /** 규칙 설명(조치·정책)은 첫 지적의 것을 대표로 쓴다 — 같은 규칙이면 같다 */
  remedy?: string;
  policyNote?: string;
  items: Finding[];
}

function groupByRule(findings: readonly Finding[]): Group[] {
  const byRule = new Map<string, Group>();
  for (const finding of findings) {
    // 심각도가 같은 규칙끼리만 묶는다 — 정책에 따라 같은 규칙이 위반/경고로 갈릴 수 있다
    const key = `${finding.severity}:${finding.ruleId}`;
    const group = byRule.get(key);
    if (group) {
      group.items.push(finding);
      group.fixable = group.fixable || finding.fixable === true;
    } else {
      byRule.set(key, {
        ruleId: finding.ruleId,
        severity: finding.severity,
        fixable: finding.fixable === true,
        ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
        ...(finding.policyNote === undefined ? {} : { policyNote: finding.policyNote }),
        items: [finding],
      });
    }
  }
  return [...byRule.values()].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.items.length - a.items.length,
  );
}

const LEVEL_LABEL = { error: tr('위반'), warning: tr('경고'), info: tr('참고') } as const;

export function FindingsPanel({ findings, skipped, onSelect, activePointer }: Props): React.JSX.Element {
  const groups = groupByRule(findings);
  const errors = groups.filter((group) => group.severity === 'error');
  const warnings = groups.filter((group) => group.severity === 'warning');
  const infos = groups.filter((group) => group.severity === 'info');
  const count = (list: Group[]): number => list.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="findings">
      <h2><T k={'위반 {0}건{1}'} v={[count(errors), <span className="sub">{' '}<T k={'· 경고 {0}건'} v={[count(warnings)]} /></span>]} />
      </h2>

      {/* 🔴 위반과 경고를 칸으로 가른다 — 한 목록에 섞여 있으니 「경고 9건」도 제출을 막는 것처럼 읽혔다
          (사용자 2026-09-30). 위반은 제출 전에 반드시 고칠 것, 경고는 제출을 막지 않지만 확인할 것 */}
      <section className="findings-section error">
        <h3>
          <T k={'{0} {1}건{2}'} v={[<span className="level error">{tr('위반')}</span>, count(errors), <span className="sub"> {tr('— 반드시 고칩니다(KOSMO 규칙)')}</span>]} />
        </h3>
        {errors.length === 0 ? (
          <p className="hint">{tr('위반이 없습니다 — KOSMO 규칙을 모두 지켰습니다.')}</p>
        ) : (
          <ul>{errors.map((group) => renderGroup(group))}</ul>
        )}
      </section>

      <section className="findings-section warning">
        <h3>
          <T k={'{0} {1}건{2}'} v={[<span className="level warning">{tr('경고')}</span>, count(warnings), <span className="sub"> {tr('— 확인하고 필요하면 「자동 고치기」')}</span>]} />
        </h3>
        {warnings.length === 0 ? (
          <p className="hint">{tr('경고가 없습니다.')}</p>
        ) : (
          <ul>{warnings.map((group) => renderGroup(group))}</ul>
        )}
      </section>
      {/* 참고(info)는 고칠 것이 없는 사실 전달이다 — 경고와 나란히 서면 "이것도 경고냐"고 묻는다(2026-09-07).
          접어 두고, 펼치면 그대로 읽힌다 */}
      {infos.length > 0 && (
        <details className="info-fold">
          <summary><T k={'참고 {0}건 — 고칠 것 없음, 알아 둘 사실만'} v={[infos.reduce((n, g) => n + g.items.length, 0)]} /></summary>
          <ul>{infos.map((group) => renderGroup(group))}</ul>
        </details>
      )}

      {skipped && skipped.length > 0 && (
        <div className="skipped">
          {/* 못 고친 이유를 숨기지 않는다 — 사람이 판단할 몫이라는 게 Quick Fix의 전제다 */}
          <h3><T k={'자동으로 고치지 못한 것 {0}건'} v={[skipped.length]} /></h3>
          <ul>
            {skipped.map((item, index) => (
              <li key={index}>
                <span className="rule">{item.ruleId}</span> {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  function renderGroup(group: (typeof groups)[number]): React.JSX.Element {
    return (
          <li key={`${group.severity}-${group.ruleId}`} className={`${group.severity} group`}>
            <div className="head">
              {/* 색만으로 등급을 나누면 색각 이상에서 구별되지 않는다 */}
              <span className={`level ${group.severity}`}>{LEVEL_LABEL[group.severity]}</span>
              <span className="rule">{group.ruleId}</span>
              {group.items.length > 1 && <span className="count"><T k={'{0}건'} v={[group.items.length]} /></span>}
              {/* 2026-09-07부터 「자동 고치기」는 고칠 수 있는 경고도 손댄다 — 파일마다 AASd-120 1건이 늘 남았다 */}
              {group.fixable && (
                <span className="fixable" title={tr('「자동 고치기」가 규약대로 교정합니다 — 경고도 함께')}>
                  {tr('자동 고치기 대상')}
                </span>
              )}
            </div>

            {/* 대상이 하나면 옛 모양 그대로 — 묶음 표시가 오히려 번잡하다 */}
            {group.items.length === 1 ? (
              <div
                className={`single${activePointer === group.items[0]!.pointer ? ' active' : ''}`}
                onClick={() => onSelect(group.items[0]!)}
              >
                <div className="message">{group.items[0]!.message}</div>
              </div>
            ) : (
              <ul className="targets">
                {group.items.map((finding, index) => (
                  <li
                    key={`${finding.pointer}-${index}`}
                    className={activePointer === finding.pointer ? 'active' : ''}
                    onClick={() => onSelect(finding)}
                    title={finding.message}
                  >
                    {finding.key ?? finding.pointer}
                  </li>
                ))}
              </ul>
            )}

            {/* 설명은 묶음에 한 번만 — 8번 반복하면 화면이 온통 글자가 된다 */}
            {group.remedy && <div className="remedy">{group.remedy}</div>}
            {group.policyNote && <div className="policy"><T k={'정책: {0}'} v={[group.policyNote]} /></div>}
          </li>
    );
  }
}
