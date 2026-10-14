/**
 * The guarded delivery calls of the security review (items 1, 2 and 4), in one place.
 *
 * - `completeGuarded`: the completion always carries the attempt number of the claim; the store applies it only while
 *   the row is still in-flight with that attempt count and answers whether it did. A late result of an attempt that
 *   was overtaken by a newer claim therefore cannot turn a newer `succeeded` back into `pending`.
 * - `extendGuarded`: renews the lease right before the send starts, with the same guard — false means another claim
 *   owns the row now, and this attempt must not send.
 * - `claimFor`: claims the due rows of one subscription only, so the dispatcher can share its lanes fairly.
 */
import type { DeliveryRecord, DeliveryResult } from '@aas/store';

import type { IntegrationAasStore } from './deps.js';

export function completeGuarded(store: Pick<IntegrationAasStore, 'completeDelivery'>, id: string, result: DeliveryResult, attempt: number): Promise<boolean> {
  return store.completeDelivery(id, { ...result, attempt });
}

export function extendGuarded(store: Pick<IntegrationAasStore, 'extendLease'>, id: string, attempt: number, leaseUntil: string): Promise<boolean> {
  return store.extendLease(id, attempt, leaseUntil);
}

export function claimFor(store: Pick<IntegrationAasStore, 'claimDeliveries'>, now: string, limit: number, leaseMs: number, subscriptionId: string): Promise<DeliveryRecord[]> {
  return store.claimDeliveries(now, limit, leaseMs, subscriptionId);
}
