/**
 * 따라 하기 안내 — 실제 화면 위에서 주황 상자로 한 곳씩 짚는다(2026-10-08).
 *
 * 매뉴얼의 「주황 번호」를 화면 위에서 그대로 보여 주는 것이다. 처음 들어왔을 때 · 처음 파일을
 * 열었을 때 한 번씩 뜨고, 「? 도움말 → 화면 둘러보기」로 언제든 다시 본다.
 *
 * 🔴 **가리킬 것이 없으면 그 걸음은 건너뛴다.** 화면이 바뀌어 단추가 사라져도 안내가 엉뚱한 곳을
 *    짚거나 멈추지 않게 — 시험(app.test)이 걸음 수를 세어 단추가 사라지면 알려 준다.
 * 🔴 키보드로도 된다 — → 다음 · ← 이전 · Esc 그만. 「동작 줄이기」 설정이면 움직임 없이 옮겨 간다.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { TourStep } from '../help.js';
import { fill, tr } from '../i18n.js';

interface Props {
  steps: TourStep[];
  /** 끝까지 봤든 건너뛰었든 — 다시 자동으로 띄우지 않는다 */
  onClose: () => void;
  t: (text: string) => string;
}

/** 걸음이 가리키는 화면 요소 — 글자를 주면 그 글자가 든 것 중 첫째 */
export function findTarget(step: TourStep): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(step.sel)];
  const hit = step.text ? all.find((el) => (el.textContent ?? '').includes(step.text!)) : all[0];
  if (!hit) return null;
  const box = hit.getBoundingClientRect();
  // 숨겨진 것(크기 0)은 없는 것으로 본다 — jsdom에서는 모두 0이라 시험에서는 그대로 둔다
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
  // 시작할 때 화면에 있는 걸음만 — 없는 단추를 가리키지 않는다
  const [live] = useState(() => steps.filter((step) => findTarget(step) !== null));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect>();
  const card = useRef<HTMLDivElement>(null);
  const step = live[index];

  const measure = useCallback(() => {
    if (!step) return;
    const target = findTarget(step);
    if (!target) return;
    // 🔴 세로로만 끌어온다 — scrollIntoView는 좁은 화면에서 가로로도 밀어 화면이 옆으로 비켜났다(390px 실측)
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
        // 화면 전체의 Esc(선택 내려놓기 등)보다 먼저, 그리고 그것을 막는다
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, prev, onClose]);

  // 가리킬 것이 하나도 없으면 아무것도 띄우지 않고 끝낸다
  useEffect(() => {
    if (live.length === 0) onClose();
  }, [live.length, onClose]);
  if (!step) return null;

  // 설명 카드 자리 — 아래에 자리가 있으면 아래, 없으면 위. 옆으로는 화면 안에 붙든다
  const pad = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const cardW = Math.min(340, vw - 24);
  const r = rect ?? { top: vh / 2, left: vw / 2, width: 0, height: 0 };
  const below = r.top + r.height + 16 + 190 < vh;
  const big = r.height > vh * 0.6; // 칸 하나를 통째로 짚을 때 — 카드를 그 칸 안에 띄운다
  const cardTop = big ? Math.min(r.top + 24, vh - 220) : below ? r.top + r.height + 14 : Math.max(12, r.top - 14 - 190);
  const cardLeft = Math.min(Math.max(12, r.left + r.width / 2 - cardW / 2), vw - cardW - 12);

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
