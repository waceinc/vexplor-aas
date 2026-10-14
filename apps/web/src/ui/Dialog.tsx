/**
 * Dialog — the one frame for windows that float above the screen.
 *
 * Important: why it was built (2026-10-13 componentization): overlay (.modal-back) · window (.modal) · close on outside click · inner clicks not
 *    leaking to the overlay · role/aria were written by hand per screen, so the same markup existed in 9 places. If one place missed aria,
 *    screen readers could not recognize the window (two bundle windows actually had no role). The frame lives here, once.
 *    Its look comes from .modal-back · .modal in styles/aas.css (same style as the reference Dialog).
 */
import type { ReactNode } from 'react';

interface Props {
  /** Window name read by screen readers */
  label?: string;
  /** Classes appended to .modal (window width · padding) — e.g. 'wide' · 'fix-modal' */
  className?: string;
  onClose: () => void;
  /** Close button at the top right. A name that reads distinct from the text and from other "Close" buttons on the same screen */
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
