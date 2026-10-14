/**
 * MQTT delivery of events (docs/design/integration-v1.md §5.5).
 *
 * Topics under `options.topicPrefix` (default `vexplor/aas/<instanceId>`):
 *  - `{prefix}/events/{short type}` — the full CloudEvent, QoS 1, not retained. Success = PUBACK.
 *  - `{prefix}/equipment/{base64url(globalAssetId)}/state` — retained `{ state, since, eventId }` when `retainState`
 *    and the event is `equipment.state.changed.v1` (a late subscriber sees the current state at once).
 *  - `{prefix}/status` — retained `{"online": true, "since"}` after connect, will `{"online": false}`.
 * MQTT 3.1.1 has no headers, so nothing is signed: use `mqtts` and broker ACLs.
 *
 * Composition point (WP2): the client is `MqttPublisher` from `@aas/fieldbus` (`packages/fieldbus/src/mqtt-publisher.ts`).
 * This file codes against the small `MqttSinkClient` / `MqttConnect` interfaces below so it compiles before WP2 merges;
 * boot.ts passes `(options) => MqttPublisher.connect(options)` once it exists.
 * No reconnect loop here: a broken client is dropped and the next claimed delivery connects again — the delivery
 * retry schedule is the backoff.
 */
import type { LookupFunction } from 'node:net';

import { EVENT_TYPES, shortEventType, type CloudEvent } from '@aas/core';

import { encodeIdentifier } from '../base64url.js';

/** What the sink needs of an MQTT client — a subset of WP2's `MqttPublisher` */
export interface MqttSinkClient {
  publish(topic: string, payload: Buffer, options: { qos: 0 | 1; retain: boolean }): Promise<void>;
  readonly connected: boolean;
  close(): Promise<void>;
}

/** Same shape as WP2's `MqttPublisherOptions` (§5.5) */
export interface MqttSinkConnectOptions {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepAliveSec?: number;
  will?: { topic: string; payload: Buffer; retain: boolean; qos: 0 | 1 };
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  lookup?: LookupFunction;
  servername?: string;
}

export type MqttConnect = (options: MqttSinkConnectOptions) => Promise<MqttSinkClient>;

export interface MqttTarget {
  subscriptionId: string;
  /** Without userinfo */
  url: string;
  username?: string;
  password?: string;
  topicPrefix?: string;
  retainState?: boolean;
  /** Pinned address and the host name for TLS */
  lookup: LookupFunction;
  servername: string;
}

/** Topic prefix rule shared with the subscription validation: no wildcards, no NUL, ≤ 200 chars, not empty */
export function validTopicPrefix(prefix: string): boolean {
  return prefix !== '' && prefix.length <= 200 && !/[+#\u0000]/.test(prefix);
}

export function defaultTopicPrefix(instanceId: string): string {
  return `vexplor/aas/${instanceId}`;
}

export class MqttSink {
  private readonly clients = new Map<string, { client: MqttSinkClient; key: string; prefix: string }>();

  constructor(
    private readonly connect: MqttConnect,
    private readonly instanceId: () => string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private prefixOf(target: MqttTarget): string {
    return target.topicPrefix ?? defaultTopicPrefix(this.instanceId());
  }

  private async clientFor(target: MqttTarget): Promise<MqttSinkClient> {
    // Reconnect when the target changed (URL, credentials, prefix) or the old connection broke
    const key = JSON.stringify([target.url, target.username, target.password, this.prefixOf(target)]);
    const held = this.clients.get(target.subscriptionId);
    if (held && held.key === key && held.client.connected) return held.client;
    if (held) {
      this.clients.delete(target.subscriptionId);
      await held.client.close().catch(() => undefined);
    }
    const prefix = this.prefixOf(target);
    const client = await this.connect({
      url: target.url,
      ...(target.username === undefined ? {} : { username: target.username }),
      ...(target.password === undefined ? {} : { password: target.password }),
      clientId: `vexplor-aas-${this.instanceId()}-${target.subscriptionId}`.slice(0, 64),
      lookup: target.lookup,
      servername: target.servername,
      will: { topic: `${prefix}/status`, payload: Buffer.from(JSON.stringify({ online: false })), retain: true, qos: 1 },
    });
    await client.publish(`${prefix}/status`, Buffer.from(JSON.stringify({ online: true, since: this.now() })), { qos: 1, retain: true });
    this.clients.set(target.subscriptionId, { client, key, prefix });
    return client;
  }

  /** Publishes one event; resolves when the broker acknowledged it (PUBACK), rejects otherwise */
  async deliver(target: MqttTarget, event: CloudEvent, body: Buffer): Promise<void> {
    let client: MqttSinkClient;
    try {
      client = await this.clientFor(target);
    } catch (error) {
      this.clients.delete(target.subscriptionId);
      throw error;
    }
    const prefix = this.prefixOf(target);
    try {
      await client.publish(`${prefix}/events/${shortEventType(event.type)}`, body, { qos: 1, retain: false });
      const globalAssetId = (event.data['asset'] as { globalAssetId?: string | null } | undefined)?.globalAssetId;
      if (target.retainState && event.type === EVENT_TYPES.equipmentStateChanged && typeof globalAssetId === 'string') {
        const state = { state: event.data['state'], since: event.time, eventId: event.id };
        await client.publish(`${prefix}/equipment/${encodeIdentifier(globalAssetId)}/state`, Buffer.from(JSON.stringify(state)), {
          qos: 1,
          retain: true,
        });
      }
    } catch (error) {
      // A failed publish leaves the connection in an unknown state — start clean next time
      this.clients.delete(target.subscriptionId);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /** Drops the connection of one subscription (deleted, disabled, changed) */
  async forget(subscriptionId: string): Promise<void> {
    const held = this.clients.get(subscriptionId);
    this.clients.delete(subscriptionId);
    if (held) await goOffline(held);
  }

  /** Closes every connection with DISCONNECT (shutdown) */
  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map(goOffline));
  }
}

/**
 * A clean DISCONNECT does not fire the will, so the retained status would keep saying online — publish offline first.
 * Best effort: a broken connection fails here and the broker fires the will instead.
 */
async function goOffline(held: { client: MqttSinkClient; prefix: string }): Promise<void> {
  if (held.client.connected) {
    await held.client
      .publish(`${held.prefix}/status`, Buffer.from(JSON.stringify({ online: false })), { qos: 1, retain: true })
      .catch(() => undefined);
  }
  await held.client.close().catch(() => undefined);
}
