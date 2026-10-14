/**
 * Auto-fix preview — shows before/after per item for what will be fixed and how, and applies only the checked ones.
 *
 * Important: it used to fix everything with a single click. This is where the question "so you just convert it to a home-made format and that's it?"
 *    (user, 2026-09-11) came from — changes were applied without seeing what would change. The preview the server computes without saving
 *    (`GET …/fix-preview`) is drawn as a table as-is, and only the chosen (rule, location) pairs are sent to `POST …/fix`.
 *    For fixes that move IRIs, it says up front that the originals stay in the migration ledger.
 */
import { useMemo, useState } from 'react';
import type { FixReport } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

/**
 * One auto-fix group = one file.
 *
 * Opening a process (bundle) creates one per attached equipment file. Fixes are split by file and
 * written to **each file's own original** — the screen only joins them; the files remain separate.
 */
export interface FixPlan {
  packageId: string;
  /** Name shown to people — file name for the current file, equipment name for linked equipment */
  name: string;
  /** Whether this is the currently open file */
  self: boolean;
  preview: FixReport;
}

interface Props {
  plans: FixPlan[];
  busy: boolean;
  onApply: (select: { packageId: string; ruleId: string; pointer: string }[]) => void;
  onCancel: () => void;
}

/** Important: there are several files, so the key must include packageId — to tell apart the same location in different files */
const keyOf = (item: { packageId: string; ruleId: string; pointer: string }): string =>
  `${item.packageId}|${item.ruleId}|${item.pointer}`;

/**
 * Before/after value on one line — objects as JSON. Long values go in full into title.
 * Important: when empty, write the meaning rather than "—": empty before is "(없음)" (none), empty after is "(지움)" (removed).
 *    The after cell for AASd-120 (clear idShort) showed "—" and was read as "there is no after content" (user, 2026-09-11)
 */
function show(value: unknown, empty = '—'): string {
  if (value === undefined || value === null || value === '') return empty;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Fixes that move IRIs — the originals stay in the ledger */
const RELOCATING = new Set(['KOSMO-SM-3', 'KOSMO-CD-2']);

export function FixPreview({ plans, busy, onApply, onCancel }: Props): React.JSX.Element {
  // Keep the order the server gave — the linter emits violations first, so violations sit on top and warnings below.
  // File order: the current file first, then linked equipment (App passes them in that order)
  const items = useMemo(
    () => plans.flatMap((plan) => plan.preview.applied.map((fix) => ({ ...fix, packageId: plan.packageId }))),
    [plans],
  );
  const skipped = useMemo(
    () => plans.flatMap((plan) => plan.preview.skipped.map((s) => ({ ...s, file: plan.name }))),
    [plans],
  );
  const rounds = useMemo(() => Math.max(...plans.map((p) => p.preview.rounds), 1), [plans]);
  /** With two or more files, show the file name as a heading — with only one it is clutter */
  const multi = plans.length > 1;
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(items.map(keyOf)));
  const allOn = items.length > 0 && items.every((item) => picked.has(keyOf(item)));
  const toggle = (item: { packageId: string; ruleId: string; pointer: string }): void =>
    setPicked((current) => {
      const next = new Set(current);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const relocating = items.filter((item) => RELOCATING.has(item.ruleId) && picked.has(keyOf(item))).length;
  const chosen = items.filter((item) => picked.has(keyOf(item)));

  return (
    <div className="fix-preview">
      <h2><T k={'자동 고치기 — 미리보기{0}'} v={[<span className="sub">
          {' '}<T k={'· 고칠 수 있는 {0}건{1}{2}'} v={[items.length, rounds > 1 ? fill(tr(' ({0}바퀴)'), { 0: rounds }) : '', multi ? fill(tr(' · 파일 {0}개'), { 0: plans.length }) : '']} />
        </span>]} />
      </h2>
      {items.length === 0 ? (
        <p className="hint">{tr('자동으로 고칠 수 있는 지적이 없습니다.')}</p>
      ) : (
        <>
          <p className="hint"><T k={'체크한 것만 반영됩니다. 반영한 뒤에도 「↶ 되돌리기」로 한 번에 돌아옵니다.{0}'} v={[multi && tr(' 설비 파일의 교정은 그 설비 파일에 저장됩니다 — 편집과 같은 길입니다.')]} />
          </p>
          {multi && (
            <p className="row-buttons">
              <label>
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(event) =>
                    setPicked(event.target.checked ? new Set(items.map(keyOf)) : new Set())
                  }
                />{' '}
                {tr('전부 고르기')}
              </label>
            </p>
          )}
          {plans.map((plan) => {
            const own = plan.preview.applied.map((fix) => ({ ...fix, packageId: plan.packageId }));
            if (own.length === 0) return null;
            return (
              <section key={plan.packageId} className="fix-group">
                {multi && (
                  <h3>
                    {plan.name}
                    <span className="dim">{' '}<T k={'{0} · {1}건'} v={[plan.self ? tr('이 파일') : tr('설비 파일'), own.length]} /></span>
                  </h3>
                )}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          {multi ? (
                            <input
                              type="checkbox"
                              aria-label={fill(tr('{0} 전체 고르기'), { 0: plan.name })}
                              checked={own.every((item) => picked.has(keyOf(item)))}
                              onChange={(event) =>
                                setPicked((current) => {
                                  const next = new Set(current);
                                  for (const item of own) {
                                    if (event.target.checked) next.add(keyOf(item));
                                    else next.delete(keyOf(item));
                                  }
                                  return next;
                                })
                              }
                            />
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={tr('전체 고르기')}
                              checked={allOn}
                              onChange={(event) =>
                                setPicked(event.target.checked ? new Set(items.map(keyOf)) : new Set())
                              }
                            />
                          )}
                        </th>
                        <th>{tr('규칙')}</th>
                        <th>{tr('대상')}</th>
                        <th>{tr('무엇을')}</th>
                        <th>{tr('전')}</th>
                        <th></th>
                        <th>{tr('후')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {own.map((item) => {
                        const k = keyOf(item);
                        return (
                          <tr key={k} className={picked.has(k) ? '' : 'off'}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={fill(tr('{0} {1} 고르기'), { 0: item.ruleId, 1: item.key ?? item.pointer })}
                                checked={picked.has(k)}
                                onChange={() => toggle(item)}
                              />
                            </td>
                            <td className="mono rule">{item.ruleId}</td>
                            <td>
                              <b>{item.key ?? item.pointer}</b>
                              {item.elementType && <span className="dim"> {item.elementType}</span>}
                            </td>
                            <td className="what">{item.description}</td>
                            <td className="mono val" title={show(item.before, tr('(없음)'))}>{show(item.before, tr('(없음)'))}</td>
                            <td className="arrow">→</td>
                            <td className="mono val" title={show(item.after, item.before === undefined ? tr('(없음)') : tr('(지움)'))}>
                              {show(item.after, item.before === undefined ? tr('(없음)') : tr('(지움)'))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
          {relocating > 0 && (
            <p className="note warn"><T k={'이 중 <b>{0}건</b>은 IDTA 공식 IRI를 자체 IRI로 옮기는 교정입니다(KOSMO Validator가 공식 IRI를 거부하기 때문 — 정책 「KOSMO 우선」). 원본 IRI는 <b>이관 대장</b>에 남아 내려받는 .aasx에 함께 들어가고, 요약 화면에서 언제든 원본으로 되돌릴 수 있습니다.'} v={[relocating]} /></p>
          )}
        </>
      )}
      {skipped.length > 0 && (
        <details className="info-fold">
          <summary><T k={'자동으로 못 고치는 것 {0}건 — 사람이 판단할 몫'} v={[skipped.length]} /></summary>
          <ul>
            {skipped.map((item, index) => (
              <li key={`${item.file}-${item.ruleId}-${item.pointer}-${index}`}>
                <span className="mono rule">{item.ruleId}</span> {item.reason}
                {multi && <span className="dim"> — {item.file}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="row-buttons actions">
        <button
          className="primary"
          disabled={busy || chosen.length === 0}
          title={tr('체크한 것만 고칩니다 — 반영한 뒤에도 헤더의 ↶로 한 번에 돌아옵니다')}
          onClick={() =>
            onApply(chosen.map(({ packageId, ruleId, pointer }) => ({ packageId, ruleId, pointer })))
          }
        ><T k={'고른 {0}건 반영'} v={[chosen.length]} /></button>
        <button onClick={onCancel} disabled={busy}>
          {tr('취소')}
        </button>
      </div>
    </div>
  );
}
