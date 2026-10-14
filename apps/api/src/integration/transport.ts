/**
 * One send of one CloudEvent to one subscription — egress check, signing, webhook or MQTT (design §5.3–5.5).
 * Shared by the dispatcher (stored events) and the test route (`integration.ping.v1`, never stored), so a test
 * delivery is signed and checked exactly like a real one.
 */
import { randomBytes } from 'node:crypto';

import { EVENT_TYPES, type CloudEvent } from '@aas/core';
import type { SubscriptionRecord, SubscriptionSecrets } from '@aas/store';

import { cloudEventBody, sequenceText } from './cloudevents.js';
import type { TestDeliveryResult } from './deps.js';
import { checkTarget, pinnedLookup, withTimeout, type EgressPolicy } from './egress.js';
import { base32Encode } from './ids.js';
import type { MqttSink } from './mqtt-sink.js';
import type { SecretBox } from './secrets.js';
import { signatureHeaders } from './signing.js';
import { cleanError, sendWebhook, type WebhookAttempt, type WebhookOutcome } from './webhook.js';

const PING_MESSAGE = 'VEXPLOR AAS Studio test delivery';

/**
 * Cap of one MQTT attempt (connect 5 s + status and event PUBACKs). Below the claim lease (dispatcher `leaseFor`), so a
 * slow broker can never keep a row past its lease and get it sent twice.
 */
export const MQTT_ATTEMPT_MS = 30_000;

export type SubscriptionWithSecrets = SubscriptionRecord & { secrets: SubscriptionSecrets };

/** Result of one send, before it is judged */
export interface SendResult {
  statusCode?: number;
  error?: string;
  retryAfterMs?: number;
  durationMs: number;
  address?: string;
  snippet: string;
}

export interface TransportOptions {
  egress: EgressPolicy;
  secrets: SecretBox | undefined;
  /** Absent until WP2's MqttPublisher is wired (compose.ts) — MQTT deliveries then fail and retry */
  mqtt?: MqttSink;
  instanceId: () => string;
  timeoutMs?: number;
  now: () => number;
  send?: (attempt: WebhookAttempt) => Promise<WebhookOutcome>;
}

export class Transport {
  private readonly send: (attempt: WebhookAttempt) => Promise<WebhookOutcome>;

  constructor(private readonly options: TransportOptions) {
    this.send = options.send ?? ((attempt) => sendWebhook(attempt, options.now));
  }

  /** Current secret, plus the previous one while a rotation overlaps — both sign */
  private signingSecrets(secrets: SubscriptionSecrets): string[] {
    const box = this.options.secrets;
    if (!box) throw new Error('no master key (AAS_SECRET_KEY)');
    const out = [box.open(secrets.secretSealed)];
    if (secrets.previousSealed && secrets.previousUntil && Date.parse(secrets.previousUntil) > this.options.now()) {
      // A previous secret sealed with an older master key cannot be opened — sign with the current one only rather
      // than failing every delivery for the rest of the overlap (the status page reports the key mismatch)
      try {
        out.push(box.open(secrets.previousSealed));
      } catch {
        // skipped on purpose
      }
    }
    return out;
  }

  /** Egress check + one send over the subscription's transport. Never throws */
  async deliver(subscription: SubscriptionWithSecrets, event: CloudEvent, body: Buffer): Promise<SendResult> {
    const now = this.options.now;
    const started = now();
    const failed = (error: unknown, address?: string): SendResult => ({
      error: cleanError(error instanceof Error ? error.message : String(error)),
      durationMs: Math.max(0, now() - started),
      snippet: '',
      ...(address === undefined ? {} : { address }),
    });
    // Checked before **every** attempt — the DNS answer may have changed since the subscription was created
    const target = await checkTarget(subscription.url, subscription.kind, this.options.egress);
    if (!target.ok) return failed(`egress: ${target.reason}`);
    try {
      if (subscription.kind === 'mqtt') {
        const mqtt = this.options.mqtt;
        if (!mqtt) return failed('MQTT delivery is not available in this build', target.address);
        const sealed = subscription.secrets.credentialsSealed;
        const credentials = sealed === undefined ? undefined : this.options.secrets?.open(sealed);
        const colon = credentials?.indexOf(':') ?? -1;
        await withTimeout(mqtt.deliver(
          {
            subscriptionId: subscription.id,
            url: subscription.url,
            ...(credentials === undefined ? {} : { username: colon < 0 ? credentials : credentials.slice(0, colon) }),
            ...(credentials === undefined || colon < 0 ? {} : { password: credentials.slice(colon + 1) }),
            ...(subscription.options.topicPrefix ? { topicPrefix: subscription.options.topicPrefix } : {}),
            ...(subscription.options.retainState ? { retainState: true } : {}),
            address: { host: target.host, port: target.port, tls: target.tls },
            lookup: pinnedLookup(target.address),
            servername: target.host,
          },
          event,
          body,
        ), MQTT_ATTEMPT_MS, `MQTT delivery did not finish within ${MQTT_ATTEMPT_MS} ms`);
        return { statusCode: 200, durationMs: Math.max(0, now() - started), address: target.address, snippet: '' };
      }
      return await this.send({
        url: subscription.url,
        address: target.address,
        body,
        headers: signatureHeaders(this.signingSecrets(subscription.secrets), event.id, Math.floor(now() / 1000), body),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      });
    } catch (error) {
      return failed(error, target.address);
    }
  }

  /** `integration.ping.v1` to one subscription — signed like real events, never stored */
  async ping(subscription: SubscriptionWithSecrets): Promise<TestDeliveryResult> {
    const serverTime = new Date(this.options.now()).toISOString();
    const event: CloudEvent = {
      specversion: '1.0',
      id: `evt_${base32Encode(randomBytes(17)).slice(0, 26)}`,
      source: `urn:vexplor-aas:${this.options.instanceId()}`,
      type: EVENT_TYPES.integrationPing,
      time: serverTime,
      datacontenttype: 'application/json',
      sequence: sequenceText(0),
      data: { subscriptionId: subscription.id, serverTime, message: PING_MESSAGE },
    };
    const result = await this.deliver(subscription, event, cloudEventBody(event));
    const { statusCode } = result;
    if (result.error === undefined && statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
      return { ok: true, statusCode, durationMs: result.durationMs, address: result.address ?? '', responseSnippet: result.snippet, serverTime };
    }
    return {
      ok: false,
      error: result.error ?? `HTTP ${statusCode}`,
      ...(statusCode === undefined ? {} : { statusCode }),
      durationMs: result.durationMs,
      ...(result.address === undefined ? {} : { address: result.address }),
      serverTime,
    };
  }
}
