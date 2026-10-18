/**
 * How a remote collector is doing (2.8.0) — OK, Attention or Problem, with the reasons — and the compact points kept for
 * its trend. The server decides this in one place so the screen and the guides (usage §8-8) say the same thing.
 *
 * Important: the thresholds live only in EDGE_HEALTH_THRESHOLDS. apps/api/test/edge-health.test.ts checks that the
 *    table in docs/usage.md and docs/사용법.md states the same numbers — change both together.
 * Important: `lastStatus` comes from a device. Every field is read with a type check and a wrong type is ignored, never
 *    trusted: a broken or hostile collector must not make the screen say "OK" or throw.
 * Important: a status is the state when its batch was made (edge contract §5.1). Times inside it ("failing for how long",
 *    "a recent write error") are measured against that moment, not against now; only "silent" is measured against now.
 * Important: an edge 1.0.x sends no host, server or per-link numbers. What is missing is not judged — the screen says
 *    the version does not send it, instead of calling the collector healthy or broken for it.
 */
import { fill, tr } from '@aas/core';

export const EDGE_HEALTH_THRESHOLDS = {
  /** No batch for longer than this → Problem (the same limit as the "Silent" badge) */
  silentAfterMs: 180_000,
  /** Free space on the factory PC's disk under this share → Attention */
  diskFreeAttentionPercent: 10,
  /** … under this share → Problem */
  diskFreeProblemPercent: 2,
  /** Sending to the server failing for longer than this → Attention */
  sendFailingAttentionMs: 60_000,
  /** The PC clock off from the server's by more than this, either way → Attention */
  clockOffsetAttentionMs: 5_000,
  /** An interface reading successfully less often than this → Attention */
  readOkAttentionRatio: 0.9,
  /** A failed queue write within this long before the status → Attention (the edge keeps reporting the last one) */
  queueWriteRecentMs: 3_600_000,
  /** Batches dropped within this long → Attention */
  droppedWindowMs: 3_600_000,
} as const;

export type EdgeHealthLevel = 'ok' | 'attention' | 'problem';

export interface EdgeHealthReason {
  code: string;
  level: 'attention' | 'problem';
  message: string;
  interfaceId?: string;
}

export interface EdgeHealthVerdict {
  level: EdgeHealthLevel;
  reasons: EdgeHealthReason[];
}

/** One point of a collector's trend — 5 minutes, the last status in it (short keys: 288 a day are kept per collector) */
export interface EdgeHistoryPoint {
  at: string;
  /** Values stored in this period */
  values: number;
  cpu?: number;
  mem?: number;
  /** Disk free, % */
  disk?: number;
  clock?: number;
  rtt?: number;
  queued?: number;
  memQueued?: number;
  dropped?: number;
  /** Sends without a 2xx since the last one with */
  fails?: number;
  links?: { id: string; up: boolean; ratio?: number; ms?: number }[];
}

export interface EdgeHealthInput {
  lastSeenAt: string | null;
  /** When the batch that carried `lastStatus` was made (its createdAt); lastSeenAt when unknown */
  statusAt?: string;
  lastStatus: Record<string, unknown> | null;
  history: EdgeHistoryPoint[];
}

const T = EDGE_HEALTH_THRESHOLDS;

const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const time = (value: unknown): number | undefined => {
  const text = str(value);
  const parsed = text === undefined ? NaN : Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const links = (status: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  Array.isArray(status?.['interfaces']) ? (status['interfaces'] as unknown[]).map(obj).filter((link) => link !== undefined) : [];
const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Undefined when the collector never sent a batch — there is nothing to judge yet */
export function judgeEdge(input: EdgeHealthInput, now: Date): EdgeHealthVerdict | null {
  const seen = time(input.lastSeenAt);
  if (seen === undefined) return null;
  const status = obj(input.lastStatus);
  const at = time(input.statusAt) ?? seen;
  const host = obj(status?.['host']);
  const server = obj(status?.['server']);
  const reasons: EdgeHealthReason[] = [];
  const problem = (code: string, message: string) => reasons.push({ code, level: 'problem', message });
  const attention = (code: string, message: string, interfaceId?: string) =>
    reasons.push({ code, level: 'attention', message, ...(interfaceId ? { interfaceId } : {}) });

  // Problems
  if (now.getTime() - seen > T.silentAfterMs) {
    problem('silent', fill(tr('{0}분 넘게 소식이 없습니다 — 공장 PC가 켜져 있는지, 서버로 나가는 연결이 열려 있는지 확인하십시오.'), { 0: String(T.silentAfterMs / 60_000) }));
  }
  const all = links(status);
  if (all.length > 0 && all.every((link) => link['connected'] !== true)) {
    problem('no-equipment', fill(tr('설비 연결 0/{0} — 연결된 설비가 없습니다.'), { 0: String(all.length) }));
  }
  const disk = num(host?.['diskFreePercent']);
  if (disk !== undefined && disk < T.diskFreeProblemPercent) {
    problem('disk-full', fill(tr('공장 PC 디스크가 거의 찼습니다 — 남은 공간 {0}%(기준 {1}% 미만).'), { 0: String(round(disk)), 1: String(T.diskFreeProblemPercent) }));
  }

  // Attention
  if (disk !== undefined && disk >= T.diskFreeProblemPercent && disk < T.diskFreeAttentionPercent) {
    attention('disk-low', fill(tr('공장 PC 디스크 남은 공간이 {0}%입니다(기준 {1}% 미만).'), { 0: String(round(disk)), 1: String(T.diskFreeAttentionPercent) }));
  }
  const failures = num(server?.['sendFailuresSinceOk']) ?? 0;
  if (failures > 0) {
    const since = time(server?.['lastSendOkAt']) ?? time(status?.['startedAt']);
    if (since !== undefined && at - since > T.sendFailingAttentionMs) {
      const why = str(server?.['lastSendError']) ?? '';
      attention('send-failing', fill(tr('서버로 보내기가 {0}초째 실패하고 있습니다(실패 {1}번) — {2}'), { 0: String(Math.round((at - since) / 1000)), 1: String(failures), 2: why }));
    }
  }
  const clock = num(host?.['clockOffsetMs']);
  if (clock !== undefined && Math.abs(clock) > T.clockOffsetAttentionMs) {
    attention('clock-offset', fill(tr('공장 PC 시계가 서버와 {0}초 다릅니다(기준 {1}초 초과).'), { 0: String(round(Math.abs(clock) / 1000)), 1: String(T.clockOffsetAttentionMs / 1000) }));
  }
  for (const link of all) {
    const ratio = num(link['readOkRatio']);
    const id = str(link['interfaceId']) ?? '?';
    if (ratio !== undefined && ratio < T.readOkAttentionRatio) {
      attention('read-ok-low', fill(tr('{0} 읽기 성공률 {1}%(기준 {2}% 미만).'), { 0: id, 1: String(round(ratio * 100)), 2: String(T.readOkAttentionRatio * 100) }), id);
    }
  }
  const writeFailedAt = time(host?.['queueWriteErrorAt']);
  if (str(host?.['queueWriteError']) !== undefined && writeFailedAt !== undefined && at - writeFailedAt <= T.queueWriteRecentMs) {
    attention('queue-write-failed', fill(tr('대기열을 공장 PC 디스크에 쓰지 못했습니다 — {0}'), { 0: str(host?.['queueWriteError']) ?? '' }));
  }
  const inMemory = num(host?.['queuedInMemory']) ?? 0;
  if (inMemory > 0) {
    attention('queue-in-memory', fill(tr('디스크 대신 메모리에서 묶음 {0}개가 기다립니다 — 수집기가 다시 시작하면 잃습니다.'), { 0: String(inMemory) }));
  }
  const dropped = droppedWithin(input.history, now.getTime() - T.droppedWindowMs);
  if (dropped > 0) {
    attention('batches-dropped', fill(tr('최근 1시간 동안 보내지 못한 묶음 {0}개를 버렸습니다.'), { 0: String(dropped) }));
  }

  return { level: reasons.some((reason) => reason.level === 'problem') ? 'problem' : reasons.length > 0 ? 'attention' : 'ok', reasons };
}

/**
 * Batches dropped since `from`: the rises of droppedBatches between consecutive points. A count that falls (the edge
 * restarted and counts from 0 again) starts over instead of hiding the drops after it.
 */
function droppedWithin(history: EdgeHistoryPoint[], from: number): number {
  const points = history.filter((point) => (time(point.at) ?? 0) >= from && point.dropped !== undefined);
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const before = points[i - 1]!.dropped!;
    const after = points[i]!.dropped!;
    total += after >= before ? after - before : after;
  }
  return total;
}

/** The trend point of one status — only numbers, with the types checked */
export function pointOf(status: Record<string, unknown> | null | undefined, at: string, values: number): EdgeHistoryPoint {
  const point: EdgeHistoryPoint = { at, values };
  const s = obj(status);
  if (!s) return point;
  const host = obj(s['host']);
  const server = obj(s['server']);
  const put = <K extends keyof EdgeHistoryPoint>(key: K, value: EdgeHistoryPoint[K] | undefined) => {
    if (value !== undefined) point[key] = value;
  };
  put('cpu', num(host?.['cpuPercent']));
  put('mem', num(host?.['memoryUsedPercent']));
  put('disk', num(host?.['diskFreePercent']));
  put('clock', num(host?.['clockOffsetMs']));
  put('rtt', num(server?.['roundTripMs']));
  put('queued', num(s['queuedBatches']));
  put('memQueued', num(host?.['queuedInMemory']));
  put('dropped', num(s['droppedBatches']));
  put('fails', num(server?.['sendFailuresSinceOk']));
  const all = links(s);
  if (all.length > 0) {
    point.links = all.slice(0, 50).map((link) => {
      const ratio = num(link['readOkRatio']);
      const ms = num(link['responseMs']);
      return { id: (str(link['interfaceId']) ?? '?').slice(0, 200), up: link['connected'] === true, ...(ratio !== undefined ? { ratio } : {}), ...(ms !== undefined ? { ms } : {}) };
    });
  }
  return point;
}
