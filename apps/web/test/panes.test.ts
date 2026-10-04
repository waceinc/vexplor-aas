/**
 * 세 칸 너비 조절 검증.
 *
 * 🔴 여기서 가장 중요한 것은 **어느 칸도 사라지지 않는 것**이다.
 *    끌다가 한 칸이 0이 되면 되돌릴 손잡이조차 없어져 새로고침 말고는 길이 없다.
 * 🔴 남는 자리는 가운데가 쓴다(2026-09-09) — 저장하는 것은 왼쪽·오른쪽 두 폭이다.
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
  it('첫 손잡이는 왼쪽↔가운데만 바꾼다 — 오른쪽은 그대로', () => {
    const before = { left: 380, right: 420 };
    const after = resizePanes(before, 'left', 50, TOTAL);
    expect(after).toEqual({ left: 430, right: 420 });
    // 멀리 있는 칸이 따라 움직이면 사람이 무엇을 잡았는지 알 수 없다
    expect(middleWidth(after, TOTAL)).toBe(middleWidth(before, TOTAL) - 50);
  });

  it('둘째 손잡이는 가운데↔오른쪽만 바꾼다 — 왼쪽은 그대로', () => {
    const after = resizePanes({ left: 380, right: 440 }, 'middle', 60, TOTAL);
    expect(after.left).toBe(380);
    expect(after.right).toBe(380); // 오른쪽으로 끌었으니 오른쪽이 준다
    expect(middleWidth(after, TOTAL)).toBe(TOTAL - 380 - 380 - HANDLE * 2);
  });

  it('🔴 최소 너비를 넘겨 줄이려 하면 **움직이지 않는다**', () => {
    const tight = { left: MIN.left, right: TOTAL - MIN.left - MIN.middle - HANDLE * 2 };
    expect(resizePanes(tight, 'left', -50, TOTAL)).toEqual(tight);
    expect(resizePanes(tight, 'middle', -50, TOTAL)).toEqual(tight); // 가운데가 최소 — 더 못 줄인다
    expect(resizePanes({ left: 380, right: MIN.right }, 'middle', 50, TOTAL)).toEqual({ left: 380, right: MIN.right });
  });

  it('🔴 가운데를 최소 아래로 밀어내지 못한다 — 요약 타일이 세로로 찍힌다', () => {
    const wide = { left: 380, right: TOTAL - 380 - MIN.middle - HANDLE * 2 };
    expect(resizePanes(wide, 'left', 40, TOTAL)).toEqual(wide);
    expect(resizePanes(wide, 'middle', -40, TOTAL)).toEqual(wide);
    expect(middleWidth(wide, TOTAL)).toBe(MIN.middle);
  });

  it('한 번에 크게 끌어도 최소 너비 안쪽으로는 안 간다', () => {
    const after = resizePanes({ left: 380, right: 440 }, 'left', 5000, TOTAL);
    expect(middleWidth(after, TOTAL)).toBeGreaterThanOrEqual(MIN.middle);
    expect(after.left).toBeGreaterThanOrEqual(MIN.left);
    expect(after.right).toBeGreaterThanOrEqual(MIN.right);
  });
});

describe('clampPanes', () => {
  it('창을 줄이면 칸도 따라 줄어든다 — 가운데가 사라지지 않게', () => {
    const after = clampPanes({ left: 700, right: 600 }, 1000);
    expect(middleWidth(after, 1000)).toBeGreaterThanOrEqual(MIN.middle);
  });

  it('🔴 창이 최소 합보다 좁아도 칸을 없애지 않는다 — 가로 스크롤이 낫다', () => {
    const after = clampPanes({ left: 700, right: 600 }, 400);
    expect(after.left).toBe(MIN.left);
    expect(after.right).toBe(MIN.right);
  });

  it('넉넉하면 준 값을 그대로 지킨다 — 남는 폭은 가운데로 간다', () => {
    expect(clampPanes({ left: 400, right: 450 }, TOTAL)).toEqual({ left: 400, right: 450 });
    expect(middleWidth({ left: 400, right: 450 }, 1920)).toBe(1920 - 400 - 450 - HANDLE * 2);
  });

  it('소수점을 남기지 않는다 — 픽셀 경계에서 선이 흐려진다', () => {
    const after = clampPanes({ left: 400.6, right: 450.2 }, TOTAL);
    expect(Number.isInteger(after.left)).toBe(true);
    expect(Number.isInteger(after.right)).toBe(true);
  });
});

describe('gridTemplate', () => {
  it('손잡이 자리를 포함한 다섯 칸을 낸다 — 가운데가 1fr', () => {
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

  it('🔴 예전 판이 더 좁게 저장해 둔 값은 지금 최소로 올린다 — 깨진 화면을 사람이 고칠 길이 없다', async () => {
    expect(await withStorage({ left: 380, right: 120 })).toEqual({ left: 380, right: MIN.right });
  });

  it('예전 판의 {left, middle} 저장값은 뜻이 다르다 — 읽지 않고 기본으로', async () => {
    expect(await withStorage({ left: 380, middle: 620 })).toBeUndefined();
  });
});
