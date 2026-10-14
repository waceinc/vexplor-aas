/**
 * Card header — title and a "Close" on the right. The file list and history cards share this header (.file-list-head).
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
