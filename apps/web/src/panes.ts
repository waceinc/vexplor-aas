/**
 * 세 칸 너비 — 사용자가 마우스로 끌어 조절한다.
 *
 * 왜 필요한가: 사람마다 보는 것이 다르다. 트리를 넓게 보는 사람, 속성 칸이 넓어야 하는 사람,
 * 수집 표를 크게 보는 사람이 각각 있다. 고정 비율은 그중 한 사람에게만 맞는다.
 *
 * 화면이 없어도 성립하는 순수 로직이다(model.ts·addressList.ts와 같은 자리).
 * 🔴 여기서 가장 중요한 것은 **어느 칸도 사라지지 않는 것**이다. 끌다가 한 칸이 0이 되면
 *    되돌릴 손잡이조차 없어진다 — 그래서 모든 계산이 최소 너비를 먼저 지킨다.
 *
 * 🔴 **남는 자리는 가운데가 쓴다**(2026-09-09 디자인 검토). 전에는 오른쪽(수집)이 1fr이어서
 *    1920px 창에서 편집·요약이 서는 가운데는 620px에 묶이고, 대개 비어 있는 수집 칸이 900px을
 *    차지했다. 작업이 일어나는 칸이 넓어져야 한다. 그래서 저장하는 값은 **왼쪽·오른쪽** 두 폭이다.
 */

export interface PaneWidths {
  /** 왼쪽(트리) 너비 px */
  left: number;
  /** 오른쪽(수집) 너비 px — 가운데는 남는 자리를 쓴다 */
  right: number;
}

/** 손잡이 두께 px — 너비 계산에 함께 들어간다 */
export const HANDLE = 6;

/**
 * 칸마다 최소 너비.
 * 🔴 가운데가 가장 크다 — 요약 타일 3장·새로 만들기 폼·파일 목록이 다 거기 선다.
 *    200이었을 때 220px까지 줄인 화면에서 「7 서브모델」이 세로로 한 글자씩 찍히고
 *    파일 이름이 세 줄로 꺾였다(2026-09-07 실측). 400은 타일 3장이 한 줄에 서는 폭이다.
 * 🔴 오른쪽은 수집 표에 항목·값·시각 세 열이 들어가서, 좁으면 글자가 잘린다(실측).
 */
export const MIN = { left: 220, middle: 400, right: 260 } as const;

/**
 * 기본 너비. 1280px 창에서 가운데가 508px — 예전 기본(620)보다 좁지만 semanticId IRI가 한 줄에
 * 서는 폭(디자인 점검 2026-09-03: 340px에서 꺾였다)은 넘고, 창이 넓어지면 가운데가 그만큼 는다.
 */
export const DEFAULT_PANES: PaneWidths = { left: 360, right: 400 };

/** 가운데 칸은 남은 자리를 쓴다 — 따로 저장하지 않는다 */
export function middleWidth(widths: PaneWidths, total: number): number {
  return total - widths.left - widths.right - HANDLE * 2;
}

/**
 * 창 크기 안에 들어오게 다듬는다.
 *
 * 🔴 창이 세 칸의 최소 너비 합보다 좁을 수도 있다(작은 노트북·분할 화면).
 *    그때는 최소 너비를 그대로 돌려준다 — 가로 스크롤이 생길지언정 칸이 사라지지는 않는다.
 */
export function clampPanes(widths: PaneWidths, total: number): PaneWidths {
  const room = total - HANDLE * 2;
  const left = Math.max(MIN.left, Math.round(widths.left));
  const right = Math.max(MIN.right, Math.round(widths.right));
  if (room - left - right >= MIN.middle) return { left, right };

  // 가운데 자리가 모자란다 — 오른쪽을 먼저 줄이고, 그래도 모자라면 왼쪽을 줄인다
  const rightFitted = Math.max(MIN.right, room - left - MIN.middle);
  const leftFitted = Math.max(MIN.left, room - rightFitted - MIN.middle);
  return { left: leftFitted, right: rightFitted };
}

export type Handle = 'left' | 'middle';

/**
 * 손잡이 하나를 끈 결과.
 *
 * 🔴 **맞닿은 두 칸만** 바뀐다. 첫 손잡이는 왼쪽↔가운데, 둘째는 가운데↔오른쪽이다.
 *    멀리 있는 칸까지 따라 움직이면 사람이 무엇을 잡았는지 알 수 없게 된다.
 */
export function resizePanes(
  current: PaneWidths,
  handle: Handle,
  deltaPx: number,
  total: number,
): PaneWidths {
  if (handle === 'left') {
    // 왼쪽이 커진 만큼 가운데가 줄어든다 — 오른쪽은 그대로
    const left = current.left + deltaPx;
    if (left < MIN.left || middleWidth({ ...current, left }, total) < MIN.middle) return current;
    return clampPanes({ ...current, left }, total);
  }
  // 손잡이를 오른쪽으로 끌면 가운데가 커지고 오른쪽이 줄어든다 — 왼쪽은 그대로
  const right = current.right - deltaPx;
  if (right < MIN.right || middleWidth({ ...current, right }, total) < MIN.middle) return current;
  return clampPanes({ ...current, right }, total);
}

/** CSS grid-template-columns 값 — 가운데는 최소를 지키며 남는 자리를 채운다 */
export function gridTemplate(widths: PaneWidths): string {
  return `${widths.left}px ${HANDLE}px minmax(${MIN.middle}px, 1fr) ${HANDLE}px ${widths.right}px`;
}

const STORAGE_KEY = 'aas.panes';

/**
 * 저장된 너비를 읽는다.
 * 🔴 브라우저가 저장소를 막아 두는 경우(사생활 보호 모드·정책)가 있어 반드시 감싼다 —
 *    여기서 터지면 화면 전체가 안 뜬다.
 * 예전 판은 {left, middle}을 저장했다 — 뜻이 달라진 값이라 읽지 않고 기본으로 돌아간다.
 */
export function loadPanes(): PaneWidths | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    if (typeof parsed.left !== 'number' || typeof parsed.right !== 'number') return undefined;
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.right)) return undefined;
    // 예전 판에서 더 좁게 저장해 둔 값은 지금 최소로 올린다 — 깨진 화면을 사람이 고칠 길이 없다
    return { left: Math.max(MIN.left, parsed.left), right: Math.max(MIN.right, parsed.right) };
  } catch {
    return undefined;
  }
}

export function savePanes(widths: PaneWidths): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // 저장 못 해도 이번 판에서는 잘 돌아간다 — 조용히 넘어간다
  }
}
