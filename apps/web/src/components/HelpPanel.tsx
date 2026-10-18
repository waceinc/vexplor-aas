/**
 * "? Help" — help that opens from the right (2026-10-08).
 *
 * Important: **the topic matching the current screen is expanded first.** A first-time user does not even know what to look for —
 *    handing them a table of contents is no different from opening the manual.
 * Important: it does not cover the screen (no dimmed backdrop). Users must be able to follow along while reading the help.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { helpTopics, topicFor, type HelpContext } from '../help.js';
import { tr } from '../i18n.js';

interface Props {
  context: HelpContext;
  /** A topic to open first instead of the current screen's — a window's own "More" link names its topic */
  topic?: string;
  onClose: () => void;
  /** Replay the guided tour — the one for the current screen */
  onTour: () => void;
  /** Show the getting-started list again */
  onChecklist: () => void;
  t: (text: string) => string;
}

export function HelpPanel({ context, topic, onClose, onTour, onChecklist, t }: Props): React.JSX.Element {
  const topics = useMemo(() => helpTopics(), []);
  const first = topic && topics.some((item) => item.id === topic) ? topic : topicFor(context);
  const [open, setOpen] = useState<string>(first);
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLElement>(null);

  // When opened, focus the panel — readable by keyboard right away, closed with Esc
  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Before the screen-wide Esc (dropping the selection, etc.), and blocking it
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? topics.filter((topic) => [topic.title, topic.summary, topic.note ?? '', ...topic.steps].join(' ').toLowerCase().includes(q))
    : // Current screen topic at the top
      [...topics.filter((topic) => topic.id === first), ...topics.filter((topic) => topic.id !== first)];

  return (
    <aside className="help-panel" role="dialog" aria-label={t('도움말')} tabIndex={-1} ref={panel}>
      <div className="help-head">
        <h2>{t('도움말')}</h2>
        <button className="link" onClick={onClose} aria-label={t('도움말 닫기')}>
          {t('닫기')} ✕
        </button>
      </div>
      <input
        className="help-search"
        type="search"
        value={query}
        placeholder={t('무엇을 찾으세요? 예: 내려받기')}
        aria-label={t('도움말 찾기')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="help-actions">
        <button onClick={onTour}>{t('▶ 화면 둘러보기')}</button>
        <button onClick={onChecklist}>{t('시작하기 목록 보기')}</button>
      </div>
      {shown.length === 0 && <p className="hint">{t('찾는 내용이 없습니다. 다른 말로 찾아보세요.')}</p>}
      <div className="help-topics">
        {shown.map((topic) => {
          const expanded = q !== '' || open === topic.id;
          return (
            <section key={topic.id} className={`help-topic${expanded ? ' open' : ''}`}>
              <h3>
                <button
                  className="help-topic-head"
                  aria-expanded={expanded}
                  onClick={() => setOpen(open === topic.id ? '' : topic.id)}
                >
                  <span>{topic.title}</span>
                  {topic.id === first && q === '' && <span className="help-here">{t('지금 화면')}</span>}
                  <span className="caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
                </button>
              </h3>
              {expanded && (
                <div className="help-body">
                  <p>{topic.summary}</p>
                  <ol>
                    {topic.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {topic.note && <p className="help-note">💡 {topic.note}</p>}
                  {topic.link && (
                    <p>
                      <a href={topic.link.href} target="_blank" rel="noopener noreferrer">{topic.link.label} →</a>
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <p className="hint help-foot">{tr('검사 규칙의 자세한 설명은 「설정 ▾ → 규칙과 규약 보기」에 있습니다.')}</p>
    </aside>
  );
}
