/**
 * Widths of the three panes — the user adjusts them by dragging with the mouse.
 *
 * Why: people look at different things. Some want a wide tree, some need a wide properties pane,
 * some want a large collection table. A fixed ratio fits only one of them.
 *
 * Pure logic that holds without a screen (same place as model.ts and addressList.ts).
 * Important: the most important thing here is that **no pane ever disappears**. If a pane hits 0 while dragging,
 *    even the handle to bring it back is gone — so every calculation enforces the minimum width first.
 *
 * Important: **the middle takes the leftover space** (design review 2026-09-09). Previously the right (collection) pane was 1fr, so
 *    in a 1920px window the middle, where editing and the summary live, was stuck at 620px while the usually empty collection pane
 *    took 900px. The pane where the work happens must grow. So the stored values are the two widths, **left and right**.
 */

export interface PaneWidths {
  /** Left (tree) width in px */
  left: number;
  /** Right (collection) width in px — the middle takes the leftover space */
  right: number;
}

/** Handle thickness in px — included in the width calculation */
export const HANDLE = 6;

/**
 * Minimum width per pane.
 * Important: the middle is the largest — the three summary tiles, the New form and the file list all live there.
 *    At 200, a screen shrunk to 220px printed "7 Submodels" vertically one character per line and
 *    wrapped file names onto three lines (measured 2026-09-07). 400 is the width at which the three tiles fit on one row.
 * Important: the right pane holds three columns (item, value, time) in the collection table, so text is clipped when narrow (measured).
 */
export const MIN = { left: 220, middle: 400, right: 260 } as const;

/**
 * Default widths. In a 1280px window the middle is 508px — narrower than the old default (620), but above the width at which
 * a semanticId IRI fits on one line (design check 2026-09-03: it wrapped at 340px), and the middle grows as the window widens.
 */
export const DEFAULT_PANES: PaneWidths = { left: 360, right: 400 };

/** The middle pane takes the remaining space — not stored separately */
export function middleWidth(widths: PaneWidths, total: number): number {
  return total - widths.left - widths.right - HANDLE * 2;
}

/**
 * Trim to fit inside the window size.
 *
 * Important: the window may be narrower than the sum of the three minimum widths (small laptops, split screens).
 *    In that case return the minimum widths as is — better a horizontal scrollbar than a vanished pane.
 */
export function clampPanes(widths: PaneWidths, total: number): PaneWidths {
  const room = total - HANDLE * 2;
  const left = Math.max(MIN.left, Math.round(widths.left));
  const right = Math.max(MIN.right, Math.round(widths.right));
  if (room - left - right >= MIN.middle) return { left, right };

  // Not enough room for the middle — shrink the right first, then the left if still short
  const rightFitted = Math.max(MIN.right, room - left - MIN.middle);
  const leftFitted = Math.max(MIN.left, room - rightFitted - MIN.middle);
  return { left: leftFitted, right: rightFitted };
}

export type Handle = 'left' | 'middle';

/**
 * Result of dragging one handle.
 *
 * Important: **only the two adjacent panes** change. The first handle is left↔middle, the second is middle↔right.
 *    If distant panes moved along too, people could not tell what they had grabbed.
 */
export function resizePanes(
  current: PaneWidths,
  handle: Handle,
  deltaPx: number,
  total: number,
): PaneWidths {
  if (handle === 'left') {
    // The middle shrinks by as much as the left grows — the right stays as is
    const left = current.left + deltaPx;
    if (left < MIN.left || middleWidth({ ...current, left }, total) < MIN.middle) return current;
    return clampPanes({ ...current, left }, total);
  }
  // Dragging the handle right grows the middle and shrinks the right — the left stays as is
  const right = current.right - deltaPx;
  if (right < MIN.right || middleWidth({ ...current, right }, total) < MIN.middle) return current;
  return clampPanes({ ...current, right }, total);
}

/** CSS grid-template-columns value — the middle fills the leftover space while keeping its minimum */
export function gridTemplate(widths: PaneWidths): string {
  return `${widths.left}px ${HANDLE}px minmax(${MIN.middle}px, 1fr) ${HANDLE}px ${widths.right}px`;
}

const STORAGE_KEY = 'aas.panes';

/**
 * Read the stored widths.
 * Important: browsers sometimes block storage (private mode, policy), so always wrap it —
 *    if it throws here, the whole screen fails to load.
 * Older versions stored {left, middle} — the meaning changed, so they are not read and defaults are used instead.
 */
export function loadPanes(): PaneWidths | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    if (typeof parsed.left !== 'number' || typeof parsed.right !== 'number') return undefined;
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.right)) return undefined;
    // Values saved narrower by an older version are raised to today's minimum — people have no way to fix a broken screen
    return { left: Math.max(MIN.left, parsed.left), right: Math.max(MIN.right, parsed.right) };
  } catch {
    return undefined;
  }
}

export function savePanes(widths: PaneWidths): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Even if saving fails, it works fine for this load — move on quietly
  }
}
