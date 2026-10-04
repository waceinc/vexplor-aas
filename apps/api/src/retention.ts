/**
 * 수집값 보존 기간(retention) — `COLLECT_RETENTION_DAYS`.
 *
 * 수집(M8)을 켜 두면 값은 끝없이 쌓인다(5초 주기 × 태그 20개 = 하루 35만 행). 기간을 정해 두면
 * 그보다 오래된 값을 기동 때 한 번, 그 뒤 한 시간마다 지운다.
 *
 * 🔴 기본은 **끄기(0 = 영구 보관)**다. 판올림했더니 값이 사라졌다는 사고가 디스크가 찬 것보다
 *    나쁘다 — 지우는 것은 배포자가 명시적으로 정한다. 배포 구성(docker-compose)은 180일을 적어 둔다.
 *    모델·리비전은 건드리지 않는다(A안 — 값은 파일과 별개다).
 */
import type { AasStore } from '@aas/store';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** 유효하지 않거나 0 이하면 0(끄기). 소수도 받는다(0.5 = 12시간, 시험용) */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv): number {
  const days = Number(env['COLLECT_RETENTION_DAYS']);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export interface RetentionHandle {
  /** 지금 한 번 지우고 지운 개수를 돌려준다 */
  pruneNow(): Promise<number>;
  stop(): void;
}

/**
 * 기간이 0이면 아무것도 하지 않는 손잡이를 돌려준다(호출자가 분기하지 않도록).
 * 주기 타이머는 `unref`한다 — 이것 때문에 프로세스가 안 꺼지면 안 된다.
 */
export function startRetention(
  store: AasStore,
  days: number,
  options: { sweepMs?: number; now?: () => number; onError?: (error: unknown) => void } = {},
): RetentionHandle {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => console.error('  ⚠️  수집값 정리 실패:', error));
  if (days <= 0) return { pruneNow: async () => 0, stop: () => undefined };

  const pruneNow = () => store.pruneValues(new Date(now() - days * DAY_MS).toISOString());
  const timer = setInterval(() => {
    pruneNow().catch(onError);
  }, options.sweepMs ?? RETENTION_SWEEP_MS);
  timer.unref();
  return { pruneNow, stop: () => clearInterval(timer) };
}
