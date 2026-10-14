/**
 * Three-pane width resizing tests.
 *
 * Important: what matters most here is that **no pane ever disappears**.
 *    If a pane hits 0 while dragging, even the handle to restore it is gone and only a reload helps.
 * Important: leftover space goes to the middle (2026-09-09); what is stored is the left and right widths.
 */
import { describe, expect, it } from 'vitest';
import {
  clampPanes,
  DEFAULT_PANES,
  gridTemplate,
  HANDLE,
  MIN,
  middleWidth,
  resizePanes,
} from '../src/panes.js';

const TOTAL = 1600;

describe('resizePanes', () => {
  it('the first handle changes only left/middle; right stays', () => {
    const before = { left: 380, right: 420 };
    const after = resizePanes(before, 'left', 50, TOTAL);
    expect(after).toEqual({ left: 430, right: 420 });
    // if a distant pane moved along, people could not tell what they grabbed
    expect(middleWidth(after, TOTAL)).toBe(middleWidth(before, TOTAL) - 50);
  });

  it('the second handle changes only middle/right; left stays', () => {
    const after = resizePanes({ left: 380, right: 440 }, 'middle', 60, TOTAL);
    expect(after.left).toBe(380);
    expect(after.right).toBe(380); // dragged right, so the right pane shrinks
    expect(middleWidth(after, TOTAL)).toBe(TOTAL - 380 - 380 - HANDLE * 2);
  });

  it('Important: shrinking past the minimum width **does not move**', () => {
    const tight = { left: MIN.left, right: TOTAL - MIN.left - MIN.middle - HANDLE * 2 };
    expect(resizePanes(tight, 'left', -50, TOTAL)).toEqual(tight);
    expect(resizePanes(tight, 'middle', -50, TOTAL)).toEqual(tight); // middle at minimum: cannot shrink further
    expect(resizePanes({ left: 380, right: MIN.right }, 'middle', 50, TOTAL)).toEqual({ left: 380, right: MIN.right });
  });

  it('Important: cannot push the middle below its minimum (summary tiles would stack vertically)', () => {
    const wide = { left: 380, right: TOTAL - 380 - MIN.middle - HANDLE * 2 };
    expect(resizePanes(wide, 'left', 40, TOTAL)).toEqual(wide);
    expect(resizePanes(wide, 'middle', -40, TOTAL)).toEqual(wide);
    expect(middleWidth(wide, TOTAL)).toBe(MIN.middle);
  });

  it('even a large drag in one go stays within the minimum width', () => {
    const after = resizePanes({ left: 380, right: 440 }, 'left', 5000, TOTAL);
    expect(middleWidth(after, TOTAL)).toBeGreaterThanOrEqual(MIN.middle);
    expect(after.left).toBeGreaterThanOrEqual(MIN.left);
    expect(after.right).toBeGreaterThanOrEqual(MIN.right);
  });
});

describe('clampPanes', () => {
  it('shrinking the window shrinks the panes too, without the middle disappearing', () => {
    const after = clampPanes({ left: 700, right: 600 }, 1000);
    expect(middleWidth(after, 1000)).toBeGreaterThanOrEqual(MIN.middle);
  });

  it('Important: panes are not removed even when the window is narrower than the minimum sum (horizontal scroll is better)', () => {
    const after = clampPanes({ left: 700, right: 600 }, 400);
    expect(after.left).toBe(MIN.left);
    expect(after.right).toBe(MIN.right);
  });

  it('keeps given values when there is room; spare width goes to the middle', () => {
    expect(clampPanes({ left: 400, right: 450 }, TOTAL)).toEqual({ left: 400, right: 450 });
    expect(middleWidth({ left: 400, right: 450 }, 1920)).toBe(1920 - 400 - 450 - HANDLE * 2);
  });

  it('leaves no fractions (lines blur on pixel boundaries)', () => {
    const after = clampPanes({ left: 400.6, right: 450.2 }, TOTAL);
    expect(Number.isInteger(after.left)).toBe(true);
    expect(Number.isInteger(after.right)).toBe(true);
  });
});

describe('gridTemplate', () => {
  it('emits five tracks including handle slots, middle is 1fr', () => {
    expect(gridTemplate(DEFAULT_PANES)).toBe(
      `${DEFAULT_PANES.left}px ${HANDLE}px minmax(${MIN.middle}px, 1fr) ${HANDLE}px ${DEFAULT_PANES.right}px`,
    );
  });
});

describe('loadPanes', () => {
  const withStorage = async (stored: unknown) => {
    const { loadPanes } = await import('../src/panes.js');
    const store = new Map<string, string>([['aas.panes', JSON.stringify(stored)]]);
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      return loadPanes();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  };

  it('Important: values an older version stored narrower are raised to the current minimum (people have no way to fix a broken screen)', async () => {
    expect(await withStorage({ left: 380, right: 120 })).toEqual({ left: 380, right: MIN.right });
  });

  it('the older {left, middle} stored value means something else: ignored, use defaults', async () => {
    expect(await withStorage({ left: 380, middle: 620 })).toBeUndefined();
  });
});
