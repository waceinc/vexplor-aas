/**
 * Create collection connection — "Many by pattern". Saves typing dozens of same-shaped tags by hand (calculation in pattern.ts).
 */
import { useState } from 'react';
import { fill, tr } from '../../i18n.js';
import { expandPattern, PATTERN_LIMIT } from './pattern.js';

interface Props {
  /** Example of the address template — differs per protocol */
  hrefExample: string;
  onAdd: (rows: { name: string; href: string }[]) => void;
  onClose: () => void;
}

export function AidPattern({ hrefExample, onAdd, onClose }: Props): React.JSX.Element {
  const [name, setName] = useState('Tag{i}');
  const [href, setHref] = useState(hrefExample);
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('4');
  const [step, setStep] = useState('1');
  const result = expandPattern({ name, href, from: Number(from), to: Number(to), step: Number(step) });
  const first = result.rows[0];
  const last = result.rows[result.rows.length - 1];
  const problem =
    result.problem === 'name'
      ? tr('이름 틀에 {n} 또는 {i} 가 있어야 이름이 겹치지 않습니다')
      : result.problem === 'range'
        ? tr('시작 · 끝 · 간격은 정수이고, 끝이 시작보다 크거나 같고, 간격은 1 이상입니다')
        : result.problem === 'too-many'
          ? fill(tr('한 번에 {0}개까지 만듭니다'), { 0: PATTERN_LIMIT })
          : undefined;
  return (
    <div className="aid-pattern">
      <p className="hint">{tr('{n} 은 번호(시작부터 간격씩), {i} 는 몇 번째(1부터)입니다. {n:2} 처럼 자리수를 주면 앞을 0 으로 채웁니다.')}</p>
      <div className="aid-pattern-grid">
        <label>
          {tr('이름 틀')}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {tr('주소 틀')}
          <input className="mono" value={href} onChange={(event) => setHref(event.target.value)} />
        </label>
        <label>
          {tr('시작')}
          <input inputMode="numeric" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          {tr('끝')}
          <input inputMode="numeric" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label>
          {tr('간격')}
          <input inputMode="numeric" value={step} onChange={(event) => setStep(event.target.value)} />
        </label>
      </div>
      {problem ? (
        <p className="note warn">{problem}</p>
      ) : (
        first &&
        last && (
          <p className="hint mono">
            {fill(tr('{0}개 — {1} ({2}) … {3} ({4})'), { 0: result.rows.length, 1: first.name, 2: first.href, 3: last.name, 4: last.href })}
          </p>
        )
      )}
      <div className="row-buttons">
        <button className="primary" disabled={result.rows.length === 0} onClick={() => onAdd(result.rows)}>
          {fill(tr('{0}개 담기'), { 0: result.rows.length })}
        </button>
        <button onClick={onClose}>{tr('닫기')}</button>
      </div>
    </div>
  );
}
