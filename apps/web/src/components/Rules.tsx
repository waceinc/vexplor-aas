/**
 * Rules · conventions screen — **"on what basis do we call it a pass"**.
 *
 * This is where reviewers and clients ask for the basis of a judgement. If it were written only in documents it could drift
 * from the rules actually running, so it **receives the rules currently running on the server as is** and draws them.
 *
 * Important: do not blur who judges. This tool's linter **filters before submission**;
 *    the pass verdict comes from KOSMO Validator and aas-test-engines — that fact goes at the very top.
 */
import { useEffect, useState } from 'react';
import { api, type RuleCatalog } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  onClose: () => void;
}

export function Rules({ onClose }: Props): React.JSX.Element {
  const [catalog, setCatalog] = useState<RuleCatalog>();
  const [error, setError] = useState<string>();
  const [layer, setLayer] = useState<'all' | 'L1' | 'L2' | 'L3'>('all');

  useEffect(() => {
    void api
      .rules()
      .then(setCatalog)
      .catch(() => setError(tr('규칙 목록을 받지 못했습니다.')));
  }, []);

  if (error) return <div className="rules"><p className="note error">{error}</p></div>;
  if (!catalog) return <div className="rules"><p className="hint">{tr('불러오는 중…')}</p></div>;

  const rules = layer === 'all' ? catalog.rules : catalog.rules.filter((rule) => rule.layer === layer);

  return (
    <div className="rules">
      <div className="rules-head">
        <h2>{tr('이 도구가 지키는 규칙과 규약')}</h2>
        <span className="hint"><T k={'규칙 {0}종 · 자동 교정 {1}종'} v={[catalog.rules.length, catalog.rules.filter((r) => r.fixable).length]} /></span>
        <span className="spacer" />
        <button onClick={onClose}>{tr('닫기')}</button>
      </div>

      {/* Important: at the very top — this tool does not decide the pass */}
      <section>
        <h3>{tr('합격은 누가 정하는가')}</h3>
        <dl className="verdict-list">
          {catalog.verdict.map((entry) => (
            <div key={entry.who}>
              <dt>{entry.who}</dt>
              <dd>{entry.role}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h3>{tr('규약 — 새로 만들 때 이 형식을 따릅니다')}</h3>
        {/* Important: show where the value came from. If a policy-file change did not take effect, it shows up here */}
        {(() => {
          const changed = catalog.sources.filter((entry) => entry.from !== 'default');
          return changed.length === 0 ? (
            <p className="hint"><T k={'전부 <b>기본값</b>입니다(코드에 심어 둔 실측 기준).'} /></p>
          ) : (
            <p className="note ok"><T k={'정책 파일로 바꾼 항목: <b>{0}</b>'} v={[changed.map((entry) => entry.key).join(' · ')]} />
            </p>
          );
        })()}
        <table className="conventions">
          <tbody>
            {catalog.conventions.map((item) => (
              <tr key={item.key}>
                <th>{item.title}</th>
                <td className="mono">{item.value}</td>
                <td className="dim">{item.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>{tr('규정이 충돌할 때 — 무엇을 골랐는가')}</h3>
        <p className="hint"><T k={'KTL 규정과 KOSMO Validator가 정면으로 부딪히는 자리입니다. 한쪽을 조용히 고르지 않고<b> 지금 무엇을 골랐는지 </b>보여 줍니다.'} /></p>
        {catalog.conflicts.map((conflict) => (
          <div className="conflict-card" key={conflict.key}>
            <b>{conflict.title}</b>
            <p className="dim">{conflict.conflict}</p>
            <ul>
              {conflict.choices.map((choice) => (
                <li key={choice.value} className={choice.value === conflict.current ? 'chosen' : ''}>
                  <span className="mono">{choice.value}</span> — {choice.meaning}
                  {choice.value === conflict.current && <b className="mark"> {tr('← 지금 이것')}</b>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section>
        <h3><T k={'규칙 {0}종'} v={[catalog.rules.length]} /></h3>
        <div className="row-buttons">
          {/* Important: keep the chosen value ('all') separate from the visible text ("All") — translating the value would match nothing on the English screen */}
          {(['all', 'L1', 'L2', 'L3'] as const).map((key) => (
            <button
              key={key}
              className={layer === key ? 'primary' : ''}
              title={
                key === 'all'
                  ? tr('규칙 전부를 봅니다')
                  : key === 'L1'
                    ? tr('L1 — 파일(OPC 패키지) 규칙')
                    : key === 'L2'
                      ? tr('L2 — AAS 메타모델 제약(AASd-*)')
                      : tr('L3 — KOSMO 사업 규칙')
              }
              onClick={() => setLayer(key)}
            >
              {key === 'all' ? tr('전체') : key}
              {key !== 'all' && ` (${catalog.layers.find((l) => l.layer === key)?.count ?? 0})`}
            </button>
          ))}
        </div>
        {catalog.layers
          .filter((entry) => layer === 'all' || entry.layer === layer)
          .map((entry) => (
            <p className="hint layer-note" key={entry.layer}>
              <b>{entry.title}</b> — {entry.meaning}
            </p>
          ))}
        <table className="rule-list">
          <thead>
            <tr>
              <th>{tr('규칙')}</th>
              <th>{tr('계층')}</th>
              <th>{tr('내용')}</th>
              <th>{tr('근거')}</th>
              <th>{tr('교정')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="mono id">{rule.id}</td>
                <td className="dim">{rule.layer}</td>
                <td>{rule.title}</td>
                <td className="dim source">{rule.source}</td>
                <td className={rule.fixable ? 'ok' : 'dim'}>{rule.fixable ? tr('자동') : tr('사람')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
