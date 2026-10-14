/**
 * Widths of the three panes (tree · middle · right) — set by dragging the handles, and shrunk to fit the window at draw time.
 * Split out of App.tsx (2026-10-13 componentization). The math is in panes.ts (pure functions); here only state and window-size watching.
 */
import { useEffect, useRef, useState } from 'react';
import { clampPanes, DEFAULT_PANES, loadPanes, resizePanes, savePanes, type Handle, type PaneWidths } from '../panes.js';

export function usePanes() {
  /**
   * Three pane widths — the user sets them by dragging (requested 2026-09-01).
   * Important: `clampPanes` always re-checks that they fit the window. When the window shrinks and
   *    the saved widths stayed as they were, the right pane disappeared along with the handle to bring it back.
   */
  const [panes, setPanes] = useState<PaneWidths>(() => loadPanes() ?? DEFAULT_PANES);
  const mainRef = useRef<HTMLElement>(null);
  /**
   * Current window width. Important: `panes` is **what the user asked for**; the drawn widths are shrunk to fit the window
   * at draw time (`clampPanes`). Previously the shrunk value overwrote the state — after narrowing and widening the window once,
   * the right pane stuck at its minimum (260px) and never came back (measured 2026-09-09, 1024→1920).
   */
  const [room, setRoom] = useState<number>(() => globalThis.innerWidth ?? 1280);

  /** Horizontal width available in the current window — falls back to the window width when absent (first render) */
  const paneRoom = (): number => mainRef.current?.clientWidth ?? globalThis.innerWidth ?? 1280;
  const shownPanes = clampPanes(panes, room);

  const movePane = (handle: Handle, delta: number): void => {
    // Dragging starts from the pane as currently shown — if the desired value exceeds the window, the handle moves in the wrong place
    setPanes((current) => resizePanes(clampPanes(current, paneRoom()), handle, delta, paneRoom()));
  };
  /** Save once when dragging ends — writing on every move hammers localStorage */
  const commitPanes = (): void => setPanes((current) => (savePanes(current), current));

  // Re-fit when the window size changes — otherwise a pane disappears in a narrowed window
  useEffect(() => {
    const onResize = (): void => setRoom(paneRoom());
    globalThis.addEventListener('resize', onResize);
    onResize();
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  return { mainRef, panes, setPanes, shownPanes, movePane, commitPanes };
}
