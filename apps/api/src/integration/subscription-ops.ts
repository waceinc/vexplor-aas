/**
 * The heavier subscription operations behind the routes: replay and the status report (§4.2).
 */
import { fill, tr } from '@aas/core';
import type { DeliveryRecord, SubscriptionRecord } from '@aas/store';

import { ApiError } from '../http.js';
import { subscriptionMatches } from './delivery-policy.js';
import type { IntegrationAasStore, IntegrationRouteDeps, IntegrationServices } from './deps.js';
import { BLOCKED_PORTS } from './egress.js';

const PAGE = 1000;

export interface ReplayFrom {
  fromSeq?: string;
  from?: string;
}

/** `{ "fromSeq": "1000" }` (inclusive) or `{ "from": "<ISO time>" }` (events recorded at or after it) */
export function parseReplayBody(body: unknown): { afterSeq: number; fromTime?: number; echo: ReplayFrom } {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const keys = Object.keys(input);
  const fromSeq = input['fromSeq'];
  const from = input['from'];
  if (keys.length !== 1 || (fromSeq === undefined && from === undefined)) {
    throw new ApiError(400, 'BadRequest', tr('fromSeq 또는 from 중 하나만 주십시오.'));
  }
  if (fromSeq !== undefined) {
    const text = String(fromSeq);
    if (!/^\d+$/.test(text) || Number(text) < 1) throw new ApiError(400, 'BadRequest', tr('fromSeq는 1 이상의 정수여야 합니다.'));
    return { afterSeq: Number(text) - 1, echo: { fromSeq: text } };
  }
  const time = typeof from === 'string' ? Date.parse(from) : NaN;
  if (Number.isNaN(time)) throw new ApiError(400, 'BadRequest', fill(tr('시각을 읽지 못했습니다: {0}'), { 0: String(from) }));
  return { afterSeq: 0, fromTime: time, echo: { from: new Date(time).toISOString() } };
}

async function existingDeliveries(store: IntegrationAasStore, subscriptionId: string): Promise<Map<number, DeliveryRecord>> {
  const out = new Map<number, DeliveryRecord>();
  let cursor: string | undefined;
  do {
    const page = await store.listDeliveries(subscriptionId, { limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const row of page.items) out.set(row.eventSeq, row);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/**
 * Enqueues every retained event from the given point that matches the subscription. Rows that already exist are set
 * back to pending (a finished or dead row is sent again); rows waiting or in flight are left alone.
 * Returns how many rows will be (re)sent.
 */
export async function replay(store: IntegrationAasStore, subscription: SubscriptionRecord, body: unknown, now: number): Promise<{ enqueued: number; echo: ReplayFrom }> {
  const { afterSeq, fromTime, echo } = parseReplayBody(body);
  const existing = await existingDeliveries(store, subscription.id);
  const fresh: { subscriptionId: string; eventSeq: number; eventId: string }[] = [];
  const again: string[] = [];
  let after = afterSeq;
  for (;;) {
    const page = await store.readEvents({ after, limit: PAGE, includeAudit: false });
    for (const row of page.items) {
      if (fromTime !== undefined && Date.parse(row.recordedAt) < fromTime) continue;
      if (!subscriptionMatches(subscription, row)) continue;
      const held = existing.get(row.seq);
      if (!held) fresh.push({ subscriptionId: subscription.id, eventSeq: row.seq, eventId: row.id });
      else if (held.status === 'succeeded' || held.status === 'dead') again.push(held.id);
    }
    if (page.items.length < PAGE) break;
    after = page.items[page.items.length - 1]!.seq;
  }
  const at = new Date(now).toISOString();
  const inserted = fresh.length === 0 ? 0 : await store.enqueueDeliveries(fresh, at);
  let reset = 0;
  for (const id of again) if (await store.redeliver(id, at)) reset++;
  return { enqueued: inserted + reset, echo };
}

/** GET /integrations/status */
export async function statusReport(store: IntegrationAasStore, deps: IntegrationRouteDeps, services: IntegrationServices): Promise<Record<string, unknown>> {
  const status = services.status();
  const stats = await store.deliveryStats();
  const oldest = stats.map((entry) => entry.oldestPendingAt).filter((at): at is string => at !== undefined).sort()[0];
  return {
    enabled: status.enabled,
    ...(status.reason ? { reason: status.reason } : {}),
    demo: status.demo ?? deps.demo,
    instanceId: await services.instanceId(),
    serverTime: new Date(services.now()).toISOString(),
    running: status.running,
    workers: status.workers ?? {},
    backlog: {
      pending: stats.reduce((sum, entry) => sum + entry.pending + entry.inFlight, 0),
      ...(oldest ? { oldestPendingAt: oldest } : {}),
      dead: stats.reduce((sum, entry) => sum + entry.dead, 0),
    },
    egress: { allow: services.egress.allow.map((entry) => entry.text), blockedPorts: [...BLOCKED_PORTS] },
    masterKey: services.masterKey,
    opcua: services.opcua(),
  };
}
