/**
 * 세 칸(트리 · 가운데 · 오른쪽) 너비 — 사람이 손잡이로 끌어 정하고, 창 폭에 맞춰 그때그때 줄여 그린다.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 계산은 panes.ts(순수 함수), 여기는 상태와 창 크기 감시만.
 */
import { useEffect, useRef, useState } from 'react';
import { clampPanes, DEFAULT_PANES, loadPanes, resizePanes, savePanes, type Handle, type PaneWidths } from '../panes.js';

export function usePanes() {
  /**
   * 세 칸 너비 — 사용자가 끌어 정한다(2026-09-01 요청).
   * 🔴 창 크기 안에 들어오는지는 `clampPanes`가 늘 다시 본다. 창을 줄였을 때
   *    저장해 둔 너비가 그대로 남으면 오른쪽 칸이 사라져 되돌릴 손잡이조차 없어진다.
   */
  const [panes, setPanes] = useState<PaneWidths>(() => loadPanes() ?? DEFAULT_PANES);
  const mainRef = useRef<HTMLElement>(null);
  /**
   * 지금 창의 가로 폭. 🔴 `panes`는 **사람이 바란 값**이고, 그리는 값은 창에 맞춰 그때그때 줄인다
   * (`clampPanes`). 전에는 줄인 값을 상태에 덮어써서 — 창을 한 번 좁혔다 넓히면 오른쪽 칸이
   * 최소(260px)에 눌러앉아 돌아오지 않았다(2026-09-09 실측, 1024→1920).
   */
  const [room, setRoom] = useState<number>(() => globalThis.innerWidth ?? 1280);

  /** 지금 창에서 쓸 수 있는 가로 폭 — 없으면 창 너비로 갈음한다(첫 렌더) */
  const paneRoom = (): number => mainRef.current?.clientWidth ?? globalThis.innerWidth ?? 1280;
  const shownPanes = clampPanes(panes, room);

  const movePane = (handle: Handle, delta: number): void => {
    // 끌기는 지금 보이는 칸에서 시작한다 — 바라는 값이 창보다 크면 손잡이가 엉뚱한 데서 움직인다
    setPanes((current) => resizePanes(clampPanes(current, paneRoom()), handle, delta, paneRoom()));
  };
  /** 저장은 끌기가 끝났을 때 한 번만 — 움직일 때마다 쓰면 localStorage를 두드린다 */
  const commitPanes = (): void => setPanes((current) => (savePanes(current), current));

  // 창 크기가 바뀌면 다시 맞춘다 — 안 그러면 좁혀진 창에서 칸 하나가 사라진다
  useEffect(() => {
    const onResize = (): void => setRoom(paneRoom());
    globalThis.addEventListener('resize', onResize);
    onResize();
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  return { mainRef, panes, setPanes, shownPanes, movePane, commitPanes };
}
