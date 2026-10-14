/**
 * Notice bar at the top of the screen — trial · error · conflict · notice · fix result.
 * Five places each drew the same shape (text + a "Close" text button on the right); gathered into one (2026-10-13).
 * The look comes from the bar's kind class (.demo-bar · .error-bar · .notice · .conflict · .fix-report).
 */
import type { ReactNode } from 'react';

interface Props {
  kind: 'demo-bar' | 'error-bar' | 'notice' | 'conflict' | 'fix-report';
  role?: 'alert' | 'alertdialog';
  /** When given, a close text button is appended at the end */
  onClose?: () => void;
  closeText?: string;
  children: ReactNode;
}

export function Banner({ kind, role, onClose, closeText, children }: Props): React.JSX.Element {
  return (
    <div className={kind} {...(role ? { role } : {})}>
      {children}
      {onClose && (
        <button className="link" onClick={onClose}>
          {closeText}
        </button>
      )}
    </div>
  );
}
