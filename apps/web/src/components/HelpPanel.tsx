/**
 * 「? 도움말」 — 오른쪽에서 열리는 도움말(2026-10-08).
 *
 * 🔴 **지금 화면에 맞는 주제를 먼저** 펼친다. 처음 쓰는 사람은 무엇을 찾아야 할지도 모른다 —
 *    목차부터 내밀면 매뉴얼을 펼친 것과 다르지 않다.
 * 🔴 화면을 가리지 않는다(배경을 어둡게 하지 않는다). 도움말을 보면서 그대로 따라 할 수 있어야 한다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { helpTopics, topicFor, type HelpContext } from '../help.js';
import { tr } from '../i18n.js';

interface Props {
  context: HelpContext;
  onClose: () => void;
  /** 따라 하기 안내를 다시 — 지금 화면에 맞는 것으로 */
  onTour: () => void;
  /** 시작하기 목록을 다시 보이기 */
  onChecklist: () => void;
  t: (text: string) => string;
}

export function HelpPanel({ context, onClose, onTour, onChecklist, t }: Props): React.JSX.Element {
  const topics = useMemo(() => helpTopics(), []);
  const first = topicFor(context);
  const [open, setOpen] = useState<string>(first);
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLElement>(null);

  // 열리면 패널로 포커스 — 키보드로 바로 읽고 Esc로 닫는다
  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 화면 전체의 Esc(선택 내려놓기 등)보다 먼저, 그리고 그것을 막는다
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
    : // 지금 화면 주제를 맨 위로
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
