/**
 * 자동 고치기 미리보기 — 무엇을 어떻게 고칠지 항목별 전/후를 보여 주고, 체크한 것만 반영한다.
 *
 * 🔴 전에는 버튼 한 번에 전부 고쳐졌다. "자체 제작 형식으로 바꿔 버리고 끝이냐"는 물음(사용자 2026-09-11)이
 *    나온 자리 — 무엇이 바뀌는지 보지 못한 채 반영됐기 때문이다. 서버가 저장 없이 계산한
 *    미리보기(`GET …/fix-preview`)를 그대로 표로 그리고, 고른 (규칙, 위치)만 `POST …/fix`로 보낸다.
 *    IRI를 옮기는 교정은 원본이 이관 대장에 남는다는 사실을 여기서 먼저 말한다.
 */
import { useMemo, useState } from 'react';
import type { FixReport } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

/**
 * 자동 고치기 한 묶음 = 한 파일.
 *
 * 공정(묶음)을 열면 이어 붙인 설비 파일마다 하나씩 생긴다. 고치기는 파일별로 나눠
 * **각자의 원본**에 쓴다 — 화면이 이어 붙였을 뿐 파일은 따로이기 때문이다.
 */
export interface FixPlan {
  packageId: string;
  /** 사람에게 보여 줄 이름 — 지금 파일은 파일명, 연결 설비는 설비 이름 */
  name: string;
  /** 지금 열려 있는 파일인가 */
  self: boolean;
  preview: FixReport;
}

interface Props {
  plans: FixPlan[];
  busy: boolean;
  onApply: (select: { packageId: string; ruleId: string; pointer: string }[]) => void;
  onCancel: () => void;
}

/** 🔴 파일이 여럿이므로 열쇠에 packageId가 들어가야 한다 — 다른 파일의 같은 자리를 구분한다 */
const keyOf = (item: { packageId: string; ruleId: string; pointer: string }): string =>
  `${item.packageId}|${item.ruleId}|${item.pointer}`;

/**
 * 전/후 값을 한 줄로 — 객체는 JSON. 긴 것은 title에 전부.
 * 🔴 비어 있으면 「—」가 아니라 뜻을 적는다: 전이 비면 「(없음)」, 후가 비면 「(지움)」.
 *    AASd-120(idShort 지우기)의 후 칸이 「—」라 "에프터 내용이 없다"로 읽혔다(사용자 2026-09-11)
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

/** IRI를 옮기는 교정 — 원본이 대장에 남는 것들 */
const RELOCATING = new Set(['KOSMO-SM-3', 'KOSMO-CD-2']);

export function FixPreview({ plans, busy, onApply, onCancel }: Props): React.JSX.Element {
  // 서버가 준 순서 그대로 — 린터가 위반을 먼저 내므로 위반이 위, 경고가 아래에 선다.
  // 파일 순서는 지금 파일이 먼저, 그다음 연결 설비(App이 그 순서로 넘긴다)
  const items = useMemo(
    () => plans.flatMap((plan) => plan.preview.applied.map((fix) => ({ ...fix, packageId: plan.packageId }))),
    [plans],
  );
  const skipped = useMemo(
    () => plans.flatMap((plan) => plan.preview.skipped.map((s) => ({ ...s, file: plan.name }))),
    [plans],
  );
  const rounds = useMemo(() => Math.max(...plans.map((p) => p.preview.rounds), 1), [plans]);
  /** 파일이 둘 이상이면 파일 이름을 제목으로 보여 준다 — 하나뿐이면 군더더기다 */
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
