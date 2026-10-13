/**
 * 값 신선도 — 항목마다 「받는 중 · 끊김(마지막 값 있음) · 값 없음」 셋으로 나눈다(2026-10-13).
 *
 * 개념은 digital-twin 실운영(스피폭스 설비 약 300대)에서 왔다 — 5분 안에 들어온 값은 받는 중, 그 밖이지만
 * 마지막 값이 있으면 끊김, 한 번도 안 들어왔으면 값 없음. 코드는 옮기지 않고 여기 규칙으로 새로 썼다
 * (06_제품개발/2026H2_VEXPLOR_AAS_디자인전환/digital-twin_AAS_참조분석_2026-10-13.md §2-4).
 *
 * 🔴 판정 근거는 **수신 시각(receivedAt)** 이다. 장비 시각(observedAt)은 값이 바뀔 때만 움직여서, 값이 일정한
 *    태그는 매번 잘 읽어도 끊긴 것으로 보인다. 수신 시각이 없는 옛 기록만 장비 시각으로 대신한다.
 * 🔴 자동 수집이 느리게 돌면(예: 10분마다) 5분 창으로는 늘 끊김이다 — 창을 「수집 간격의 3배」 이상으로 넓힌다.
 */
import type { CollectedValueView } from '../../api.js';
import { fill, tr } from '../../i18n.js';

export type Freshness = 'live' | 'stale' | 'none';

/** 기본 창 — 이 안에 들어온 값은 받는 중 */
export const FRESH_WINDOW_MS = 5 * 60_000;

/** 자동 수집 간격을 보고 창을 정한다 — 간격의 3배와 5분 중 큰 쪽 */
export function freshWindowMs(intervalMs: number | undefined): number {
  return Math.max(FRESH_WINDOW_MS, 3 * (intervalMs ?? 0));
}

/** 값이 들어온 시각 — 수신 시각, 없으면(옛 기록) 장비 시각 */
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

/** 「방금 · 12초 전 · 5분 전 · 3시간 전 · 2일 전」 */
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

/** 인터페이스 하나의 합계 — 머리줄에 「받는 중 n · 끊김 n · 값 없음 n」 */
export function tallyFreshness(kinds: readonly Freshness[]): Record<Freshness, number> {
  const out: Record<Freshness, number> = { live: 0, stale: 0, none: 0 };
  for (const kind of kinds) out[kind] += 1;
  return out;
}
