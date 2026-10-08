/**
 * 시작하기 목록 — 처음 쓰는 사람이 무엇을 해 볼지 순서로 보여 준다(2026-10-08).
 *
 * 파일 열기 → 검사 결과 → 자동 고치기 → 내려받기. 해 보면 저절로 체크된다.
 * 줄을 누르면 그 일을 바로 시작한다(할 수 없는 때는 무엇을 먼저 할지 알려 준다).
 *
 * 🔴 화면 구석에 작게 — 일을 가리지 않는다. 접을 수 있고, 다 하면 저절로 사라진다.
 *    「닫기」로 숨겨도 「? 도움말 → 시작하기 목록 보기」로 다시 꺼낸다.
 */
import { useState } from 'react';

import type { StartStep } from '../help.js';
import { fill, tr } from '../i18n.js';

export interface StartItem {
  id: StartStep;
  label: string;
  hint: string;
  done: boolean;
  /** 지금 할 수 있으면 그 일을 시작한다. 없으면 hint만 보인다 */
  action?: () => void;
}

interface Props {
  items: StartItem[];
  onHide: () => void;
  t: (text: string) => string;
}

export function GettingStarted({ items, onHide, t }: Props): React.JSX.Element {
  const [folded, setFolded] = useState(false);
  const done = items.filter((item) => item.done).length;

  return (
    <aside className={`getting-started${folded ? ' folded' : ''}`} aria-label={t('시작하기')}>
      <div className="gs-head">
        <button className="gs-toggle" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          <b>{t('시작하기')}</b> <span className="gs-count">{fill(tr('{0} / {1}'), { 0: done, 1: items.length })}</span>
          <span className="caret" aria-hidden="true">{folded ? '▴' : '▾'}</span>
        </button>
        <button className="link" onClick={onHide} aria-label={t('시작하기 목록 닫기')} title={t('닫기')}>
          ✕
        </button>
      </div>
      <div className="gs-bar" aria-hidden="true">
        <i style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      {!folded && (
        <ol className="gs-list">
          {items.map((item, i) => (
            <li key={item.id} className={item.done ? 'done' : ''}>
              <button
                className="gs-item"
                disabled={item.done || !item.action}
                title={item.hint}
                onClick={() => item.action?.()}
              >
                <span className="gs-mark" aria-hidden="true">{item.done ? '✓' : i + 1}</span>
                <span className="gs-text">
                  {item.label}
                  {!item.done && <small>{item.hint}</small>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
