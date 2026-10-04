/**
 * 칸 사이 손잡이 — 끌어서 너비를 바꾼다.
 *
 * 🔴 마우스만으로 되면 절반이다. **키보드로도 되어야** 한다 —
 *    ← → 로 10px, Shift와 함께면 50px, Home으로 기본값. 손목이 불편한 사람과
 *    트랙패드에서 잡기 어려운 사람이 실제로 있다.
 * 🔴 `setPointerCapture`를 쓴다. 안 쓰면 빠르게 끌 때 포인터가 손잡이를 벗어나면서
 *    드래그가 끊긴다(실측에서 흔한 증상).
 */
import { useRef } from 'react';
import { tr, fill } from '../i18n.js';

interface Props {
  /** 무엇과 무엇 사이인지 — 읽어 주는 이름에 쓴다 */
  label: string;
  /** 지금 왼쪽 칸의 너비 — 보조기술이 값을 읽게 */
  value: number;
  onMove: (deltaPx: number) => void;
  onReset: () => void;
  /** 끌기가 끝났을 때 — 저장은 여기서 한 번만 한다 */
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
        // 왼쪽 단추만 — 오른쪽 눌러 메뉴 띄우다가 칸이 움직이면 당황스럽다
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
