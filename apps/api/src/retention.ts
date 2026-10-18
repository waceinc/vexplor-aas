/**
 * Retention period for collected values — `COLLECT_RETENTION_DAYS`.
 *
 * With collection (M8) on, values pile up endlessly (5s interval × 20 tags = 350k rows a day). If a period is set,
 * values older than that are deleted once at startup and every hour thereafter.
 *
 * Important: the default is **off (0 = keep forever)**. An incident where values vanished after an upgrade is worse than
 *    a full disk — deletion is something the deployer decides explicitly. The deployment config (docker-compose) specifies 180 days.
 *    Models and revisions are not touched (option A — values are separate from the file).
 */
import type { AasStore } from '@aas/store';
import { tr } from '@aas/core';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** 0 (off) if invalid or ≤ 0. Fractions are accepted (0.5 = 12 hours, for testing) */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv): number {
  const days = Number(env['COLLECT_RETENTION_DAYS']);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export interface RetentionHandle {
  /** Delete once now and return the number deleted */
  pruneNow(): Promise<number>;
  stop(): void;
}

/**
 * If the period is 0, return a handle that does nothing (so the caller need not branch).
 * The periodic timer is `unref`ed — it must not keep the process from exiting.
 */
export function startRetention(
  store: AasStore,
  days: number,
  options: { sweepMs?: number; now?: () => number; onError?: (error: unknown) => void } = {},
): RetentionHandle {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => console.error('  [WARN] ' + tr('수집값 정리 실패:'), error));
  if (days <= 0) return { pruneNow: async () => 0, stop: () => undefined };

  const pruneNow = () => store.pruneValues(new Date(now() - days * DAY_MS).toISOString());
  const timer = setInterval(() => {
    pruneNow().catch(onError);
  }, options.sweepMs ?? RETENTION_SWEEP_MS);
  timer.unref();
  return { pruneNow, stop: () => clearInterval(timer) };
}
