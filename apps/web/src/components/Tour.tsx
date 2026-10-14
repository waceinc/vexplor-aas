/**
 * Guided tour — points at one place at a time with an orange box on the real screen (2026-10-08).
 *
 * It shows the manual's "orange numbers" directly on screen. It appears once on first entry and once on first
 * opening a file, and can be replayed any time via "? Help → Screen tour".
 *
 * Important: **a step with nothing to point at is skipped.** So that the tour neither points at the wrong place nor
 *    stalls when the screen changes and a button disappears — a test (app.test) counts the steps and reports a missing button.
 * Important: works with the keyboard too — → next · ← previous · Esc stop. With "reduce motion" it moves without animation.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { TourStep } from '../help.js';
import { fill, tr } from '../i18n.js';

interface Props {
  steps: TourStep[];
  /** Whether finished or skipped — do not show automatically again */
  onClose: () => void;
  t: (text: string) => string;
}

/** The screen element a step points at — given text, the first element containing that text */
export function findTarget(step: TourStep): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(step.sel)];
  const hit = step.text ? all.find((el) => (el.textContent ?? '').includes(step.text!)) : all[0];
  if (!hit) return null;
  const box = hit.getBoundingClientRect();
  // Hidden elements (size 0) count as missing — in jsdom everything is 0, so tests leave them as is
  if (box.width === 0 && box.height === 0 && typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) return null;
  return hit;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour({ steps, onClose, t }: Props): React.JSX.Element | null {
  // Only steps present on screen at start — do not point at buttons that are not there
  const [live] = useState(() => steps.filter((step) => findTarget(step) !== null));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect>();
  const card = useRef<HTMLDivElement>(null);
  const step = live[index];

  const measure = useCallback(() => {
    if (!step) return;
    const target = findTarget(step);
    if (!target) return;
    // Important: scroll vertically only — scrollIntoView also shifted horizontally on narrow screens and pushed the view sideways (measured at 390px)
    let box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) {
      window.scrollBy({ top: box.top - window.innerHeight / 3 });
      box = target.getBoundingClientRect();
    }
    setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
  }, [step]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    card.current?.focus();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  const next = useCallback(() => (index + 1 >= live.length ? onClose() : setIndex(index + 1)), [index, live.length, onClose]);
  const prev = useCallback(() => setIndex(Math.max(0, index - 1)), [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Before the screen-wide Esc (dropping the selection, etc.), and blocking it
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, prev, onClose]);

  // If there is nothing to point at, show nothing and end
  useEffect(() => {
    if (live.length === 0) onClose();
  }, [live.length, onClose]);
  if (!step) return null;

  // Placement of the explanation card — below if there is room, otherwise above. Horizontally it is kept inside the screen
  // Spacing is a multiple of the CSS token (--spacing) — hard-coded numbers drift away from the screen spacing system (2026-10-14)
  const unit = spacingPx();
  const pad = unit * 2; // around the highlighted element
  const edge = unit * 3; // screen edge (same as --space-float)
  const gap = unit * 4; // between the highlighted element and the card
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const cardW = Math.min(340, vw - edge * 2);
  const cardH = 190; // estimated card height — a size, not a spacing
  const r = rect ?? { top: vh / 2, left: vw / 2, width: 0, height: 0 };
  const below = r.top + r.height + gap + cardH < vh;
  const big = r.height > vh * 0.6; // when pointing at a whole pane — float the card inside that pane
  const cardTop = big ? Math.min(r.top + unit * 6, vh - cardH - unit * 8) : below ? r.top + r.height + gap : Math.max(edge, r.top - gap - cardH);
  const cardLeft = Math.min(Math.max(edge, r.left + r.width / 2 - cardW / 2), vw - cardW - edge);

  return (
    <div className="tour" role="presentation">
      <div
        className="tour-spot"
        aria-hidden="true"
        style={{ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 }}
      />
      <div
        className="tour-card"
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('화면 둘러보기')}
        aria-describedby="tour-body"
        tabIndex={-1}
        style={{ top: cardTop, left: cardLeft, width: cardW }}
      >
        <div className="tour-count">{fill(tr('{0} / {1}'), { 0: index + 1, 1: live.length })}</div>
        <h3>{step.title}</h3>
        <p id="tour-body">{step.body}</p>
        <div className="tour-buttons">
          <button className="link" onClick={onClose}>
            {t('건너뛰기')}
          </button>
          <span className="spacer" />
          {index > 0 && <button onClick={prev}>{t('이전')}</button>}
          <button className="primary" onClick={next}>
            {index + 1 >= live.length ? t('마치기') : t('다음')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pixel value of one CSS spacing unit (--spacing). 4px (Tailwind default) if it cannot be read */
function spacingPx(): number {
  if (typeof document === 'undefined') return 4;
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue('--spacing').trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 4;
  if (raw.endsWith('rem')) return value * parseFloat(getComputedStyle(root).fontSize || '16');
  return value;
}

