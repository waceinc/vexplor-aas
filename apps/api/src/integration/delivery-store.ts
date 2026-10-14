/**
 * The guarded delivery calls of the security review (items 2 and 4), in one place.
 *
 * - `completeGuarded`: the completion carries the attempt number the claim returned; the store applies it only while
 *   the row is still in-flight with that attempt count, and answers whether it did. A late result of an overtaken
 *   attempt therefore cannot turn a newer `succeeded` back into `pending`.
 * - `claimFor`: claims the due rows of one subscription only, so the dispatcher can share its lanes fairly.
 * The store port adds both (WP1, `attempt` on DeliveryResult and the optional `subscriptionId` of claimDeliveries).
 * A store without them still works: completion then answers "applied" and the claim ignores the filter — the
 * dispatcher leaves rows it has no lane for (they come back after the lease).
 */
import type { DeliveryRecord, DeliveryResult } from '@aas/store';

import type { IntegrationAasStore } from './deps.js';

type GuardedComplete = (id: string, result: DeliveryResult & { attempt?: number }) => Promise<boolean | void>;
type FilteredClaim = (now: string, limit: number, leaseMs: number, subscriptionId?: string) => Promise<DeliveryRecord[]>;

export async function completeGuarded(store: Pick<IntegrationAasStore, 'completeDelivery'>, id: string, result: DeliveryResult, attempt: number): Promise<boolean> {
  const complete = store.completeDelivery.bind(store) as GuardedComplete;
  return (await complete(id, { ...result, attempt })) !== false;
}

export function claimFor(store: Pick<IntegrationAasStore, 'claimDeliveries'>, now: string, limit: number, leaseMs: number, subscriptionId: string): Promise<DeliveryRecord[]> {
  const claim = store.claimDeliveries.bind(store) as FilteredClaim;
  return claim(now, limit, leaseMs, subscriptionId);
}
