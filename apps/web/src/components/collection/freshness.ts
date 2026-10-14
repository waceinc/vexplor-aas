/**
 * Value freshness — splits each item into three: "receiving · stale (last value present) · no value" (2026-10-13).
 *
 * The concept comes from digital-twin's production use (about 300 machines at Speefox) — a value that arrived within 5 minutes is receiving;
 * outside that but with a last value, stale; never arrived, no value. The code was not ported but rewritten here with these rules
 * (06_제품개발/2026H2_VEXPLOR_AAS_디자인전환/digital-twin_AAS_참조분석_2026-10-13.md §2-4).
 *
 * Important: the basis is **reception time (receivedAt)**. Equipment time (observedAt) moves only when the value changes, so a tag with a
 *    constant value looks stale even when it is read fine every time. Only old records without a reception time fall back to equipment time.
 * Important: if automatic collection runs slowly (e.g. every 10 minutes), a 5-minute window is always stale — widen the window to at least "3x the collection interval".
 */
import type { CollectedValueView } from '../../api.js';
import { fill, tr } from '../../i18n.js';

export type Freshness = 'live' | 'stale' | 'none';

/** Default window — values that arrived within it are receiving */
export const FRESH_WINDOW_MS = 5 * 60_000;

/** Decides the window from the automatic collection interval — the larger of 3x the interval and 5 minutes */
export function freshWindowMs(intervalMs: number | undefined): number {
  return Math.max(FRESH_WINDOW_MS, 3 * (intervalMs ?? 0));
}

/** When the value arrived — reception time, or equipment time when absent (old records) */
export function arrivedAt(value: CollectedValueView): string {
  return value.receivedAt ?? value.observedAt;
}

export function freshnessOf(
  value: CollectedValueView | undefined,
  nowMs: number,
  windowMs: number,
): { kind: Freshness; ageMs?: number } {
  if (!value) return { kind: 'none' };
  const at = Date.parse(arrivedAt(value));
  if (Number.isNaN(at)) return { kind: 'none' };
  const ageMs = Math.max(0, nowMs - at);
  return { kind: ageMs <= windowMs ? 'live' : 'stale', ageMs };
}

/** "just now · 12 s ago · 5 min ago · 3 h ago · 2 days ago" */
export function ageLabel(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 5) return tr('방금');
  if (seconds < 60) return fill(tr('{0}초 전'), { 0: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return fill(tr('{0}분 전'), { 0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return fill(tr('{0}시간 전'), { 0: hours });
  return fill(tr('{0}일 전'), { 0: Math.floor(hours / 24) });
}

/** Totals for one interface — "receiving n · stale n · no value n" in the header row */
export function tallyFreshness(kinds: readonly Freshness[]): Record<Freshness, number> {
  const out: Record<Freshness, number> = { live: 0, stale: 0, none: 0 };
  for (const kind of kinds) out[kind] += 1;
  return out;
}
