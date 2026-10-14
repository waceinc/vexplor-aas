/**
 * Findings list — the reason this product exists (spec Ⅲ M5, PM opinion).
 *
 * Package Explorer cannot report rule violations. So findings are not a side feature;
 * they get their own pane next to the tree. Clicking a finding opens that element in the tree.
 *
 * Important: **findings of the same rule are grouped.** If AASd-120 alone has 8 findings, the same description repeats 8 times
 *    and the screen becomes a wall of text — description · fix · policy are written once per group,
 *    and targets are listed one per line. Clicking an individual target goes to that element (as before).
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
  /** The rule description (fix · policy) is taken from the first finding — it is the same for the same rule */
  remedy?: string;
  policyNote?: string;
  items: Finding[];
}

function groupByRule(findings: readonly Finding[]): Group[] {
  const byRule = new Map<string, Group>();
  for (const finding of findings) {
    // Group only rules of the same severity — depending on policy, the same rule can be a violation or a warning
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

      {/* Important: violations and warnings get separate sections — mixed in one list, "9 warnings" read as if they blocked submission too
          (user, 2026-09-30). Violations must be fixed before submission; warnings do not block submission but should be checked */}
      <section className={`findings-section error${errors.length === 0 ? ' empty' : ''}`}>
        <h3>
          <T k={'{0} {1}건{2}'} v={[<span className="level error">{tr('위반')}</span>, count(errors), <span className="sub"> {tr('— 반드시 고칩니다(KOSMO 규칙)')}</span>]} />
        </h3>
        {errors.length === 0 ? (
          <p className="hint">{tr('위반이 없습니다 — KOSMO 규칙을 모두 지켰습니다.')}</p>
        ) : (
          <ul>{errors.map((group) => renderGroup(group))}</ul>
        )}
      </section>

      <section className={`findings-section warning${warnings.length === 0 ? ' empty' : ''}`}>
        <h3>
          <T k={'{0} {1}건{2}'} v={[<span className="level warning">{tr('경고')}</span>, count(warnings), <span className="sub"> {tr('— 확인하고 필요하면 「자동 고치기」')}</span>]} />
        </h3>
        {warnings.length === 0 ? (
          <p className="hint">{tr('경고가 없습니다.')}</p>
        ) : (
          <ul>{warnings.map((group) => renderGroup(group))}</ul>
        )}
      </section>
      {/* Info items are facts with nothing to fix — next to warnings people ask "is this a warning too?" (2026-09-07).
          Collapsed; when expanded they read as is */}
      {infos.length > 0 && (
        <details className="info-fold">
          <summary><T k={'참고 {0}건 — 고칠 것 없음, 알아 둘 사실만'} v={[infos.reduce((n, g) => n + g.items.length, 0)]} /></summary>
          <ul>{infos.map((group) => renderGroup(group))}</ul>
        </details>
      )}

      {skipped && skipped.length > 0 && (
        <div className="skipped">
          {/* Do not hide why it could not be fixed — Quick Fix assumes the judgement belongs to a person */}
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
              {/* Severity by color alone is indistinguishable for color-vision deficiency */}
              <span className={`level ${group.severity}`}>{LEVEL_LABEL[group.severity]}</span>
              <span className="rule">{group.ruleId}</span>
              {group.items.length > 1 && <span className="count"><T k={'{0}건'} v={[group.items.length]} /></span>}
              {/* Since 2026-09-07 "auto fix" also touches fixable warnings — one AASd-120 per file always remained */}
              {group.fixable && (
                <span className="fixable" title={tr('「자동 고치기」가 규약대로 교정합니다 — 경고도 함께')}>
                  {tr('자동 고치기 대상')}
                </span>
              )}
            </div>

            {/* With a single target keep the old layout — group markup would only add clutter */}
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

            {/* Description once per group — repeated 8 times, the screen becomes a wall of text */}
            {group.remedy && <div className="remedy">{group.remedy}</div>}
            {group.policyNote && <div className="policy"><T k={'정책: {0}'} v={[group.policyNote]} /></div>}
          </li>
    );
  }
}
