/**
 * Handle between panes — drag to change the width.
 *
 * Important: mouse-only is only half the job. **It must work with the keyboard too** —
 *    ← → for 10px, 50px with Shift, Home for the default. There really are people with sore wrists
 *    and people who find it hard to grab on a trackpad.
 * Important: uses `setPointerCapture`. Without it, a fast drag lets the pointer leave the handle
 *    and the drag breaks off (a common symptom in measurements).
 */
import { useRef } from 'react';
import { tr, fill } from '../i18n.js';

interface Props {
  /** Between what and what — used for the accessible name */
  label: string;
  /** Current width of the left pane — so assistive technology can read the value */
  value: number;
  onMove: (deltaPx: number) => void;
  onReset: () => void;
  /** When dragging ends — saving happens here, once */
  onCommit: () => void;
}

export function Splitter({ label, value, onMove, onReset, onCommit }: Props): React.JSX.Element {
  const last = useRef<number | undefined>(undefined);

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={fill(tr('{0} 너비 조절'), { 0: label })}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={tr('끌어서 너비 조절 · 두 번 누르면 기본값')}
      onDoubleClick={() => {
        onReset();
        onCommit();
      }}
      onPointerDown={(event) => {
        // Left button only — panes moving while right-clicking for a menu is confusing
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = event.clientX;
      }}
      onPointerMove={(event) => {
        if (last.current === undefined) return;
        const delta = event.clientX - last.current;
        if (delta === 0) return;
        last.current = event.clientX;
        onMove(delta);
      }}
      onPointerUp={(event) => {
        if (last.current === undefined) return;
        last.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 50 : 10;
        if (event.key === 'ArrowLeft') onMove(-step);
        else if (event.key === 'ArrowRight') onMove(step);
        else if (event.key === 'Home') onReset();
        else return;
        event.preventDefault();
        onCommit();
      }}
    />
  );
}
