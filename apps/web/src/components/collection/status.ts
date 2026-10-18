/**
 * Collection panel — checks — latest value per item · connection state (result of the last real connection) · per-tag result of the last collection.
 * Split out of components/Collection.tsx (2026-10-13 componentization) — markup, comments and checks were moved verbatim.
 */
import type { CollectedValueView, CycleReportView } from '../../api.js';
import { fill, tr } from '../../i18n.js';

export type ConnectionStatus = { kind: 'ok' | 'warn' | 'bad' | 'idle'; label: string };
export type AutoCollect = { running: boolean; intervalMs?: number; lastSweep?: { startedAt: string; collected: number } };

/** The single latest value per property — the key is `interface/item` */
export function latestValues(values: readonly CollectedValueView[]): Map<string, CollectedValueView> {
  const latest = new Map<string, CollectedValueView>();
  for (const value of values) {
    const key = `${value.interfaceName}/${value.propertyName}`;
    const current = latest.get(key);
    if (!current || value.observedAt > current.observedAt) latest.set(key, value);
  }
  return latest;
}

/** Values that arrived this recently count as "receiving" even when this server did not read them (remote collector) */
export const RECEIVING_WINDOW_MS = 3 * 60_000;

export function connectionStatus(
  name: string,
  cycle: CycleReportView | undefined,
  auto: AutoCollect | undefined,
  packageId: string | undefined,
  latest?: ReadonlyMap<string, CollectedValueView>,
  nowMs: number = Date.now(),
): ConnectionStatus {
  /*
  * Connection state — judged by **the result of the last real connection**.
  * Important: no guessing: if it has never connected yet, it says "not collected yet".
  *    (Why there is no separate ping: checking through a path other than collection produces
  *     mismatches like "ping works but collection does not" — the basis must be collection itself)
  */
  // (1) If a collection was just tried on this screen, that result is the most accurate
  const entry = cycle?.interfaces.find((item) => item.name === name);
  if (entry) {
    if (entry.error) return { kind: 'bad', label: tr('접속 실패') };
    const report = entry.report;
    const failures = report?.failures.length ?? 0;
    const pending = report?.pending?.length ?? 0;
    /*
     * Important: **"Waiting for value" alone is not painted yellow.**
     *    The deliverables are Type/Template, so empty values are normal, and right after equipment starts
     *    dozens of tags are waiting at once. Counting those as "60 bad tags" made people ask
     *    "is it broken?" about perfectly fine equipment. The count is still stated, but not raised as a warning.
     */
    const waiting = pending > 0 ? fill(tr(' · 값 대기 {0}'), { 0: pending }) : '';
    if (failures > 0) return { kind: 'warn', label: fill(tr('연결됨 · 나쁜 태그 {0}{1}'), { 0: failures, 1: waiting }) };
    return { kind: 'ok', label: fill(tr('연결됨{0}'), { 0: waiting }) };
  }
  // (2) If automatic collection is running, use the result of the last cycle
  const sweep = auto?.lastSweep as
    | { results?: { packageId: string; collected: number; errors: string[] }[] }
    | undefined;
  const mine = sweep?.results?.find((item) => item.packageId === packageId);
  if (mine) {
    if (mine.errors.some((message) => message.startsWith(`${name}:`)))
      return { kind: 'bad', label: tr('접속 실패 (자동)') };
    if (mine.collected > 0) return { kind: 'ok', label: tr('연결됨 (자동)') };
  }
  // (3) Fresh values without this server reading them — a remote collector (VEXPLOR Edge) is sending them (2.7.0).
  //     Rows it could not read carry their reason (2.8.0) — counted like the bad tags of a collection run here
  let fresh = 0;
  let failed = 0;
  for (const [key, value] of latest ?? []) {
    if (!key.startsWith(`${name}/`)) continue;
    if (nowMs - Date.parse(value.receivedAt ?? value.observedAt) > RECEIVING_WINDOW_MS) continue;
    if (value.error !== undefined) failed += 1;
    else fresh += 1;
  }
  if (failed > 0) return { kind: 'warn', label: fill(tr('받는 중 · 나쁜 태그 {0}'), { 0: failed }) };
  if (fresh > 0) return { kind: 'ok', label: tr('받는 중') };
  return { kind: 'idle', label: tr('수집 전') };
}

/** What happened to each tag in the last collection — waiting for value · read failure (reason) */
export function tagOutcomes(cycle: CycleReportView | undefined): { waitingTags: Set<string>; failedTags: Map<string, string> } {
  /*
   * What happened to each tag in the last collection.
   * Important: the fact "there is no value" alone cannot tell **never read** from **read but nothing arrived yet**.
   *    If both show as "—" in the table, the user cannot pin down the cause.
   */
  const waitingTags = new Set<string>();
  const failedTags = new Map<string, string>();
  for (const entry of cycle?.interfaces ?? []) {
    const report = entry.report;
    for (const item of report?.pending ?? []) waitingTags.add(`${entry.name}/${item.propertyName}`);
    for (const item of report?.failures ?? []) failedTags.set(`${entry.name}/${item.propertyName}`, item.reason);
  }
  return { waitingTags, failedTags };
}
