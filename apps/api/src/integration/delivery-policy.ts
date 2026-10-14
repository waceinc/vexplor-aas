/**
 * What a delivery attempt's outcome means for the delivery row and the subscription (docs/design/integration-v1.md
 * §5.2, D8). Pure functions so the schedule and the outcome mapping are tested without sockets or clocks.
 */
import { typesMatch, isDeliverableType } from '@aas/core';
import type { StoredEvent, SubscriptionRecord } from '@aas/store';

/**
 * Delay before attempt n+1 after attempt n failed (index = n). 12 attempts over ~40 h: covers a weekend MES shutdown,
 * then the row is dead and waits for a person (redeliver / replay).
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  0, 10_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 28_800_000, 28_800_000,
];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
/** ±20 % — receivers coming back after an outage are not hit by every retry in the same second */
export const JITTER = 0.2;
export const RETRY_AFTER_CAP_MS = 3_600_000;
/** A subscription with this many dead rows in a row and no success for 72 h is switched off (never deleted) */
export const AUTO_DISABLE_DEAD = 50;
export const AUTO_DISABLE_QUIET_MS = 72 * 3_600_000;

export type AttemptVerdict =
  | { outcome: 'succeeded' }
  | { outcome: 'retry'; delayMs: number }
  | { outcome: 'dead'; disableReason?: string };

export interface AttemptFacts {
  /** Attempts made including this one (the store increments on claim) */
  attempts: number;
  statusCode?: number;
  /** Network, DNS, TLS, timeout, egress refusal, MQTT failure */
  error?: string;
  retryAfterMs?: number;
}

/** Delay before the next attempt, jittered; undefined when the attempts are used up */
export function retryDelayMs(attempts: number, random: () => number): number | undefined {
  if (attempts >= MAX_ATTEMPTS) return undefined;
  const base = RETRY_SCHEDULE_MS[attempts]!;
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

function retryable(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

/**
 * 2xx → succeeded · 410 → dead and the subscription is disabled (the receiver said "gone for good") ·
 * 408 / 425 / 429 / 5xx / no response → retry by schedule (`Retry-After` honoured, capped at 1 h) ·
 * 3xx (redirects are not followed) and other 4xx → dead (retrying the same request cannot fix it) ·
 * the 12th failed attempt → dead.
 */
export function judgeAttempt(facts: AttemptFacts, random: () => number): AttemptVerdict {
  const { statusCode } = facts;
  if (statusCode !== undefined && statusCode >= 200 && statusCode < 300 && facts.error === undefined) return { outcome: 'succeeded' };
  if (statusCode === 410) return { outcome: 'dead', disableReason: '410 from receiver' };
  if (statusCode !== undefined && !retryable(statusCode)) return { outcome: 'dead' };
  const scheduled = retryDelayMs(facts.attempts, random);
  if (scheduled === undefined) return { outcome: 'dead' };
  const delayMs = facts.retryAfterMs === undefined ? scheduled : Math.min(RETRY_AFTER_CAP_MS, facts.retryAfterMs);
  return { outcome: 'retry', delayMs };
}

/** Whether a stored event goes to a subscription — the same rule for fan-out and replay */
export function subscriptionMatches(subscription: Pick<SubscriptionRecord, 'types' | 'packageIds'>, row: Pick<StoredEvent, 'type' | 'packageId'>): boolean {
  if (!isDeliverableType(row.type)) return false;
  if (!typesMatch(subscription.types, row.type)) return false;
  if (subscription.packageIds.length === 0) return true;
  return row.packageId !== undefined && subscription.packageIds.includes(row.packageId);
}

/** Whether a subscription should be switched off after one more dead row */
export function shouldAutoDisable(subscription: Pick<SubscriptionRecord, 'consecutiveDead' | 'lastSuccessAt' | 'createdAt'>, now: number): boolean {
  if (subscription.consecutiveDead < AUTO_DISABLE_DEAD) return false;
  const lastGood = Date.parse(subscription.lastSuccessAt ?? subscription.createdAt);
  return now - lastGood >= AUTO_DISABLE_QUIET_MS;
}
