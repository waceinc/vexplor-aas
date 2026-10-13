/**
 * 화면 위쪽 알림 띠 — 체험판 · 오류 · 충돌 · 알림 · 교정 결과.
 * 같은 모양(글 + 오른쪽 「닫기」 글자 단추)을 다섯 곳이 따로 그리던 것을 하나로 모았다(2026-10-13).
 * 모양은 띠의 종류 클래스(.demo-bar · .error-bar · .notice · .conflict · .fix-report)가 맡는다.
 */
import type { ReactNode } from 'react';

interface Props {
  kind: 'demo-bar' | 'error-bar' | 'notice' | 'conflict' | 'fix-report';
  role?: 'alert' | 'alertdialog';
  /** 주면 끝에 닫기 글자 단추가 붙는다 */
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
