/**
 * 규칙·규약 화면 — **"무슨 근거로 통과라고 하는가"**.
 *
 * 검수자·발주처가 판정 근거를 묻는 자리다. 문서에만 적혀 있으면 실제로 도는 규칙과
 * 어긋날 수 있으므로, **서버에서 지금 도는 규칙을 그대로 받아** 그린다.
 *
 * 🔴 판정 주체를 흐리지 않는다. 이 도구의 린터는 **제출 전에 걸러 주는 것**이고,
 *    합격 판정은 KOSMO Validator와 aas-test-engines가 한다 — 그 사실을 맨 위에 둔다.
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

      {/* 🔴 맨 위에 둔다 — 이 도구가 합격을 결정하지 않는다 */}
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
        {/* 🔴 값이 어디서 왔는지 보여 준다. 정책 파일로 바꿨는데 안 먹었으면 여기서 드러난다 */}
        {(() => {
          const changed = catalog.sources.filter((entry) => entry.from !== '기본값');
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
          {/* 🔴 고른 값('all')과 보이는 글자(「전체」)를 가른다 — 값을 번역하면 영어일 때 어느 것과도 안 맞는다 */}
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
