/**
 * 수집 칸 — 판정 — 항목마다 가장 최근 값 · 연결 상태(마지막으로 실제 접속해 본 결과) · 태그마다 지난 수집의 결과.
 * components/Collection.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석·판정은 옮기기 전 글자 그대로다.
 */
import type { CollectedValueView, CycleReportView } from '../../api.js';
import { fill, tr } from '../../i18n.js';

export type ConnectionStatus = { kind: 'ok' | 'warn' | 'bad' | 'idle'; label: string };
export type AutoCollect = { running: boolean; intervalMs?: number; lastSweep?: { startedAt: string; collected: number } };

/** property마다 가장 최근 값 하나 — 열쇠는 `인터페이스/항목` */
export function latestValues(values: readonly CollectedValueView[]): Map<string, CollectedValueView> {
  const latest = new Map<string, CollectedValueView>();
  for (const value of values) {
    const key = `${value.interfaceName}/${value.propertyName}`;
    const current = latest.get(key);
    if (!current || value.observedAt > current.observedAt) latest.set(key, value);
  }
  return latest;
}

export function connectionStatus(name: string, cycle: CycleReportView | undefined, auto: AutoCollect | undefined, packageId: string | undefined): ConnectionStatus {
  /*
  * 연결 상태 — **마지막으로 실제 접속해 본 결과**로 판정한다.
  * 🔴 추측하지 않는다: 아직 한 번도 안 붙어 봤으면 "수집 전"이라고 말한다.
  *    (핑을 따로 치지 않는 이유: 수집과 다른 경로로 확인하면 "핑은 되는데 수집은 안 되는"
  *     어긋남이 생긴다 — 판정 근거는 수집 그 자체여야 한다)
  */
  // ① 이 화면에서 방금 수집해 봤으면 그 결과가 가장 정확하다
  const entry = cycle?.interfaces.find((item) => item.name === name);
  if (entry) {
    if (entry.error) return { kind: 'bad', label: tr('접속 실패') };
    const report = entry.report;
    const failures = report?.failures.length ?? 0;
    const pending = report?.pending?.length ?? 0;
    /*
     * 🔴 **「값 대기」만으로는 노랗게 칠하지 않는다.**
     *    산출물이 Type/Template이라 빈 값이 정상이고, 설비 기동 직후에는 태그 수십 개가
     *    한꺼번에 대기 상태다. 그걸 「나쁜 태그 60」으로 세는 바람에 멀쩡한 설비를 두고
     *    "고장 났느냐"는 물음이 나왔다. 개수는 그대로 말하되, 경고로 올리지는 않는다.
     */
    const waiting = pending > 0 ? fill(tr(' · 값 대기 {0}'), { 0: pending }) : '';
    if (failures > 0) return { kind: 'warn', label: fill(tr('연결됨 · 나쁜 태그 {0}{1}'), { 0: failures, 1: waiting }) };
    return { kind: 'ok', label: fill(tr('연결됨{0}'), { 0: waiting }) };
  }
  // ② 자동 수집이 돌고 있으면 마지막 주기의 결과를 쓴다
  const sweep = auto?.lastSweep as
    | { results?: { packageId: string; collected: number; errors: string[] }[] }
    | undefined;
  const mine = sweep?.results?.find((item) => item.packageId === packageId);
  if (mine) {
    if (mine.errors.some((message) => message.startsWith(`${name}:`)))
      return { kind: 'bad', label: tr('접속 실패 (자동)') };
    if (mine.collected > 0) return { kind: 'ok', label: tr('연결됨 (자동)') };
  }
  return { kind: 'idle', label: tr('수집 전') };
}

/** 마지막 수집에서 태그마다 무슨 일이 있었는지 — 값 대기 · 읽기 실패(사유) */
export function tagOutcomes(cycle: CycleReportView | undefined): { waitingTags: Set<string>; failedTags: Map<string, string> } {
  /*
   * 마지막 수집에서 태그마다 무슨 일이 있었는지.
   * 🔴 「값이 없다」는 사실만으로는 **한 번도 안 읽어 본 것**과 **읽었는데 아직 안 들어온 것**을
   *    구별할 수 없다. 표에서 둘 다 「—」로 보이면 사용자가 원인을 짚을 수 없다.
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
