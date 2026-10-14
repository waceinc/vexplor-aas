/**
 * 대화상자 — 화면 위에 뜨는 창의 틀 하나.
 *
 * 🔴 왜 만들었나(2026-10-13 컴포넌트화): 덮개(.modal-back) · 창(.modal) · 바깥 누르면 닫기 · 안쪽 클릭은 덮개로
 *    새지 않게 · role/aria 를 화면마다 손으로 적어 9곳에 같은 마크업이 있었다. 한 곳이 aria 를 빠뜨리면
 *    화면 낭독기가 창을 못 알아본다(실제로 번들 창 두 곳에 role 이 없었다). 틀은 여기 하나로 둔다.
 *    모양은 styles/aas.css 의 .modal-back · .modal(기준 Dialog 와 같은 결)이 맡는다.
 */
import type { ReactNode } from 'react';

interface Props {
  /** 화면 낭독기가 읽는 창 이름 */
  label?: string;
  /** .modal 에 덧붙일 클래스(창 폭·여백) — 예: 'wide' · 'fix-modal' */
  className?: string;
  onClose: () => void;
  /** 오른쪽 위 닫기 단추. 글자와, 같은 화면의 다른 「닫기」와 갈라 읽힐 이름 */
  close?: { text: string; label?: string };
  children: ReactNode;
}

export function Dialog({ label, className, onClose, close, children }: Props): React.JSX.Element {
  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        {...(label ? { 'aria-label': label } : {})}
        onClick={(event) => event.stopPropagation()}
      >
        {close && (
          <button className="link modal-close" {...(close.label ? { 'aria-label': close.label } : {})} onClick={onClose}>
            {close.text}
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
