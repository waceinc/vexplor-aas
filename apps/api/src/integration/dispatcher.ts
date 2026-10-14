/**
 * Delivery dispatcher (docs/design/integration-v1.md §5.2).
 *
 * Two loops, every second:
 *  - **fan-out** reads new events after the cursor and enqueues one delivery row per matching subscription. Enqueue is
 *    idempotent, so after a crash the next run simply re-reads from the saved cursor.
 *  - **delivery** claims due rows with a lease, sends them, and records the outcome. A process killed mid-send leaves
 *    the row in-flight; after the lease (60 s) another claim sends it again with the **same** `webhook-id`
 *    (at-least-once; receivers dedupe on it).
 * Concurrency: at most 16 sends at once, at most 4 per subscription. A claim takes only as many rows as there are
 *    free global slots; rows of a busy subscription wait in memory (they hold their lease — 16 rows × 10 s / 4 lanes
 *    = 40 s stays inside the 60 s lease).
 */
import type { CloudEvent } from '@aas/core';
import type { DeliveryRecord, DeliveryResult, StoredEvent, SubscriptionRecord } from '@aas/store';

import { cloudEventBody, toCloudEvent } from './cloudevents.js';
import { judgeAttempt, shouldAutoDisable, subscriptionMatches } from './delivery-policy.js';
import type { IntegrationAasStore, TestDeliveryResult } from './deps.js';
import type { EgressPolicy } from './egress.js';
import type { MqttSink } from './mqtt-sink.js';
import type { SecretBox, StoreKind } from './secrets.js';
import { claimFor, completeGuarded, extendGuarded } from './delivery-store.js';
import { RESOLVE_TIMEOUT_MS } from './egress.js';
import { SETTLE_MS } from './ids.js';
import { MQTT_ATTEMPT_MS, Transport, type SendResult } from './transport.js';
import { DEFAULT_TIMEOUT_MS } from './webhook.js';
import type { WebhookAttempt, WebhookOutcome } from './webhook.js';

export interface TimerHost {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DispatcherOptions {
  store: IntegrationAasStore;
  instanceId: () => string;
  publicBaseUrl?: string;
  egress: EgressPolicy;
  secrets: SecretBox | undefined;
  storeKind: StoreKind;
  /** Absent until WP2's MqttPublisher is wired — MQTT deliveries then fail and retry */
  mqtt?: MqttSink;
  timeoutMs?: number;
  now?: () => number;
  random?: () => number;
  timers?: TimerHost;
  send?: (attempt: WebhookAttempt) => Promise<WebhookOutcome>;
  intervalMs?: number;
}

export const CURSOR_KEY = 'dispatcher:cursor';
/** Lower bound of the claim lease; the real lease also covers the longest attempt twice (`leaseFor`) */
export const LEASE_MS = 60_000;
const FANOUT_BATCH = 500;
const GLOBAL_LANES = 16;
const LANES_PER_SUBSCRIPTION = 4;

/**
 * The lease must outlive one attempt with margin — otherwise a row still being sent is claimed again and sent twice.
 * One attempt = DNS (≤ 5 s) + the webhook deadline or the MQTT attempt cap, whichever is longer.
 */
export function leaseFor(timeoutMs: number): number {
  return Math.max(LEASE_MS, 2 * (Math.max(timeoutMs, MQTT_ATTEMPT_MS) + RESOLVE_TIMEOUT_MS));
}

export class Dispatcher {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: TimerHost;
  private readonly transport: Transport;
  private timer: unknown;
  private running = false;
  private stopped = true;
  private ticking = false;
  /** Rows being sent — they hold global slots */
  private claimed = 0;
  private readonly lanes = new Map<string, number>();
  /** Delivery id → the attempt number the completion must carry (a re-claim of a row still in progress bumps it) */
  private readonly inProgress = new Map<string, number>();
  private readonly active = new Set<Promise<void>>();
  /** Round-robin start, so the first subscription in the list is not always served first */
  private turn = 0;
  private readonly leaseMs: number;
  private lastFanoutAt: string | undefined;
  private cursor: number | undefined;

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? (globalThis as unknown as TimerHost);
    this.leaseMs = leaseFor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.transport = new Transport({
      egress: options.egress,
      secrets: options.secrets,
      ...(options.mqtt ? { mqtt: options.mqtt } : {}),
      instanceId: options.instanceId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: this.now,
      ...(options.send ? { send: options.send } : {}),
    });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops the loops and waits up to `waitMs` for sends in flight; their rows otherwise come back after the lease */
  async stop(waitMs = 5_000): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, waitMs);
        (handle as { unref?: () => void }).unref?.();
      }),
    ]);
    await this.options.mqtt?.close();
  }

  /** New events or redeliveries may be waiting — run soon instead of at the next tick */
  wake(): void {
    if (this.running && !this.ticking) this.schedule(0);
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      ...(this.lastFanoutAt ? { lastFanoutAt: this.lastFanoutAt } : {}),
      ...(this.cursor === undefined ? {} : { cursor: String(this.cursor) }),
      inFlight: this.claimed,
    };
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    const handle = this.timers.setTimeout(() => void this.tick(), ms);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.timer = handle;
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let full = false;
    try {
      await this.fanOut();
      full = (await this.claimAndStart()) > 0 && this.claimed < GLOBAL_LANES;
    } catch {
      // A store hiccup must not kill the loop; the next tick tries again
    } finally {
      this.ticking = false;
    }
    this.schedule(full ? 0 : (this.options.intervalMs ?? 1_000));
  }

  /** One fan-out pass. Returns the number of delivery rows enqueued */
  async fanOut(): Promise<number> {
    const { store } = this.options;
    let cursor = this.cursor ?? ((await store.getRuntimeState(CURSOR_KEY)) as number | undefined);
    if (cursor === undefined) {
      // First start: deliver what happens from now on — history is what replay is for
      const head = await store.readEvents({ after: 0, limit: 1, includeAudit: true });
      this.cursor = head.lastSeq;
      await store.putRuntimeState(CURSOR_KEY, head.lastSeq);
      return 0;
    }
    // Settled on the raw sequence inside the store (§2.4) — the same primitive as the pull feed
    const read = (after: number) => store.readEvents({ after, limit: FANOUT_BATCH, includeAudit: true, settle: { now: this.iso(), settleMs: SETTLE_MS } });
    let page = await read(cursor);
    if (page.oldestSeq !== null && cursor < page.oldestSeq - 1) {
      // Pruned while integrations were off — those events are gone; continue with what is retained
      cursor = page.oldestSeq - 1;
      page = await read(cursor);
    }
    const rows = page.items;
    this.lastFanoutAt = this.iso();
    if (rows.length === 0) {
      this.cursor = Math.max(cursor, page.frontier);
      if (this.cursor !== cursor) await store.putRuntimeState(CURSOR_KEY, this.cursor);
      return 0;
    }
    const subscriptions = (await store.listSubscriptions()).filter((subscription) => subscription.enabled);
    const enqueue: { subscriptionId: string; eventSeq: number; eventId: string }[] = [];
    for (const row of rows) {
      for (const subscription of subscriptions) {
        // A new subscription does not inherit the backlog — replay exists for that
        if (row.recordedAt < subscription.createdAt) continue;
        if (subscriptionMatches(subscription, row)) enqueue.push({ subscriptionId: subscription.id, eventSeq: row.seq, eventId: row.id });
      }
    }
    const inserted = enqueue.length === 0 ? 0 : await store.enqueueDeliveries(enqueue, this.iso());
    this.cursor = Math.max(cursor, page.frontier);
    await store.putRuntimeState(CURSOR_KEY, this.cursor);
    return inserted;
  }

  /**
   * Claims due rows **per subscription**, round-robin, never more than that subscription's free lanes — so one slow
   * receiver with a backlog holds at most 4 of the 16 slots and the others keep flowing, and no claimed row waits in
   * memory while its lease runs out. Returns how many rows were started.
   */
  async claimAndStart(): Promise<number> {
    const { store } = this.options;
    const subscriptions = (await store.listSubscriptions()).filter((subscription) => subscription.enabled);
    if (subscriptions.length === 0) return 0;
    const offset = this.turn++ % subscriptions.length;
    const order = [...subscriptions.slice(offset), ...subscriptions.slice(0, offset)];
    let started = 0;
    for (const subscription of order) {
      const free = Math.min(LANES_PER_SUBSCRIPTION - (this.lanes.get(subscription.id) ?? 0), GLOBAL_LANES - this.claimed);
      if (free <= 0) continue;
      for (const row of await claimFor(store, this.iso(), free, this.leaseMs, subscription.id)) {
        if (this.launch(row)) started++;
      }
    }
    return started;
  }

  /** Starts sending one claimed row when it has a lane; a row already in progress here is not sent a second time */
  private launch(row: DeliveryRecord): boolean {
    const id = row.id;
    if (this.inProgress.has(id)) {
      // The lease ran out while we were still sending and we claimed it again: keep the one send, complete it with the
      // newer attempt number so the completion still applies
      this.inProgress.set(id, row.attempts);
      return false;
    }
    if ((this.lanes.get(row.subscriptionId) ?? 0) >= LANES_PER_SUBSCRIPTION || this.claimed >= GLOBAL_LANES) {
      // Cannot happen with the per-subscription claim; if it does, leave the row — its lease brings it back
      return false;
    }
    this.inProgress.set(id, row.attempts);
    this.claimed++;
    this.lanes.set(row.subscriptionId, (this.lanes.get(row.subscriptionId) ?? 0) + 1);
    const work = this.attempt(row)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(work);
        this.inProgress.delete(id);
        this.claimed--;
        this.lanes.set(row.subscriptionId, (this.lanes.get(row.subscriptionId) ?? 1) - 1);
      });
    this.active.add(work);
    return true;
  }

  /** Completes a row with the attempt guard; true when the store applied it (a newer claim wins otherwise) */
  private async complete(row: DeliveryRecord, result: DeliveryResult): Promise<boolean> {
    return completeGuarded(this.options.store, row.id, result, this.inProgress.get(row.id) ?? row.attempts);
  }

  /** Delivers everything due now and waits for it — for tests and for draining */
  async runOnce(): Promise<void> {
    await this.fanOut();
    while ((await this.claimAndStart()) > 0) await this.idle();
    await this.idle();
  }

  /** Resolves when no send is in flight */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  private async eventAt(seq: number): Promise<StoredEvent | undefined> {
    const page = await this.options.store.readEvents({ after: seq - 1, limit: 1, includeAudit: true });
    const row = page.items[0];
    return row?.seq === seq ? row : undefined;
  }

  private render(row: StoredEvent): CloudEvent {
    return toCloudEvent(row, {
      instanceId: this.options.instanceId(),
      ...(this.options.publicBaseUrl ? { publicBaseUrl: this.options.publicBaseUrl } : {}),
    });
  }

  /** One attempt of one claimed row, outcome recorded */
  private async attempt(row: DeliveryRecord): Promise<void> {
    const { store } = this.options;
    const at = this.iso();
    const subscription = await store.getSubscription(row.subscriptionId);
    if (!subscription) return; // deleted meanwhile — completion would be a no-op anyway
    if (!subscription.enabled) {
      await this.complete(row, { outcome: 'dead', at, error: 'subscription disabled' });
      return;
    }
    const stored = await this.eventAt(row.eventSeq);
    if (!stored) {
      await this.complete(row, { outcome: 'dead', at, error: 'event no longer retained' });
      return;
    }
    const event = this.render(stored);
    // The send starts now: renew the lease from this moment. False = another claim owns the row — do not send
    const attempt = this.inProgress.get(row.id) ?? row.attempts;
    if (!(await extendGuarded(store, row.id, attempt, new Date(this.now() + this.leaseMs).toISOString()))) return;
    const result = await this.transport.deliver(subscription, event, cloudEventBody(event));
    await this.record(row, subscription, result);
  }

  private async record(row: DeliveryRecord, subscription: SubscriptionRecord, result: SendResult): Promise<void> {
    const { store } = this.options;
    const at = this.iso();
    const verdict = judgeAttempt(
      {
        attempts: row.attempts,
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      },
      this.random,
    );
    const facts = {
      at,
      durationMs: result.durationMs,
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.address === undefined ? {} : { address: result.address }),
    };
    // Important: the subscription counters change only when the store applied this completion — a late result of an
    //    attempt that was overtaken by a newer claim must not reset or count anything
    if (verdict.outcome === 'succeeded') {
      if (await this.complete(row, { outcome: 'succeeded', ...facts })) {
        await store.updateSubscription(subscription.id, { consecutiveDead: 0, lastSuccessAt: at });
      }
      return;
    }
    if (verdict.outcome === 'retry') {
      await this.complete(row, { outcome: 'retry', ...facts, nextAttemptAt: new Date(this.now() + verdict.delayMs).toISOString() });
      return;
    }
    if (!(await this.complete(row, { outcome: 'dead', ...facts }))) return;
    const fresh = (await store.getSubscription(subscription.id)) ?? subscription;
    const counted = { ...fresh, consecutiveDead: fresh.consecutiveDead + 1 };
    const reason = verdict.disableReason ?? (shouldAutoDisable(counted, this.now()) ? `${counted.consecutiveDead} dead deliveries in a row, no success for 72 h` : undefined);
    await store.updateSubscription(subscription.id, {
      consecutiveDead: counted.consecutiveDead,
      ...(reason === undefined ? {} : { enabled: false, disabledReason: reason }),
    });
    if (reason !== undefined) await this.options.mqtt?.forget(subscription.id);
  }

  /** POST …/test — `integration.ping.v1`, signed like real events, never stored */
  async testPing(subscriptionId: string): Promise<TestDeliveryResult | undefined> {
    const subscription = await this.options.store.getSubscription(subscriptionId);
    return subscription ? this.transport.ping(subscription) : undefined;
  }
}
