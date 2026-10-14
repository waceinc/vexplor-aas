/**
 * Getting-started list — shows first-time users, in order, what to try (2026-10-08).
 *
 * Open a file → check results → auto fix → download. Items are checked off automatically once done.
 * Clicking a row starts that task right away (when it cannot be done yet, it says what to do first).
 *
 * Important: small, in a corner of the screen — it does not cover the work. It can be collapsed and disappears by itself when everything is done.
 *    Even if hidden with "Close", it can be brought back via "? Help → Show getting-started list".
 */
import { useState } from 'react';

import type { StartStep } from '../help.js';
import { fill, tr } from '../i18n.js';

export interface StartItem {
  id: StartStep;
  label: string;
  hint: string;
  done: boolean;
  /** Starts the task if it can be done now. Otherwise only the hint is shown */
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
