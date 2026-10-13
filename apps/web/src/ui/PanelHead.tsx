/**
 * 카드 머리 — 제목과 오른쪽 「닫기」. 파일 목록 · 이력 카드가 같은 머리를 쓴다(.file-list-head).
 */
import type { ReactNode } from 'react';

export function PanelHead({ title, onClose, closeText }: { title: ReactNode; onClose: () => void; closeText: string }): React.JSX.Element {
  return (
    <div className="file-list-head">
      <h3>{title}</h3>
      <button className="link" onClick={onClose}>
        {closeText}
      </button>
    </div>
  );
}
