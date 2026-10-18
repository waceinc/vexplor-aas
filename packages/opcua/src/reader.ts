/**
 * OPC UA Client adapter — spec M8, interface priority 3.
 *
 * Uses `node-opcua` (MIT). Python/asyncua is LGPL-3.0, which constrains publishing and commercialization
 * (CLAUDE.md tech stack). This file is **the only place** that knows the protocol;
 * the rest (@aas/collector) sees only the port — because it must be testable without hardware.
 *
 * Read failures are not raised as exceptions. One bad tag must not stop the whole collection, and
 * **keeping bad values with their reason instead of discarding them** also fits option A's auditability.
 */
import { fill, tr } from '@aas/core';
import type { ProtocolReader, ReadResult } from '@aas/collector';
import {
  AttributeIds,
  DataChangeFilter,
  DataChangeTrigger,
  DeadbandType,
  OPCUACertificateManager,
  OPCUAClient,
  StatusCodes,
  TimestampsToReturn,
  type ClientMonitoredItemBase,
  type ClientSession,
  type ClientSubscription,
  type DataValue,
} from 'node-opcua';
import { secureClient, type OpcUaSecurity } from './client-security.js';

export type { OpcUaSecurity } from './client-security.js';

/**
 * Important: **the set of StatusCodes meaning "no value yet"** — this is where we tell them apart from "the read failed".
 *
 * Our outputs are Types/Templates, so empty values are normal (PROGRESS §4 design item 5), and equipment also reports
 * these states right after startup. Counting them all as failures makes healthy equipment look like "60 bad tags",
 * and novice users read that as a fault.
 *
 * Important: **do not hand-write the numbers.** Take them from node-opcua's `StatusCodes` and collect `.value` —
 *    copying constants by hand can silently drift with a single typo, and no test would catch it.
 *
 * The only selection criterion is "**the variable has no value yet**". The following are **deliberately excluded**:
 *  - `BadNoCommunication` — communication itself was never established. A real problem
 *  - `BadOutOfService` — the data source is not operating. A real problem
 *  - `UncertainNoCommunicationLastUsableValue` — there is a value (the last good one). Not pending
 */
const PENDING_STATUS: ReadonlySet<number> = new Set(
  [
    StatusCodes.BadWaitingForInitialData, // Value is being fetched from the data source
    StatusCodes.BadNoValue, // Variable with neither a default nor an initial value
    StatusCodes.BadNoData, // No data in the requested range
    StatusCodes.GoodNoData, // Same as above, but with Good severity
    StatusCodes.UncertainInitialValue, // Should get its value from another variable but still holds the initial value
  ].map((code) => code.value),
);

export interface OpcUaOptions {
  /** opc.tcp://host:port — the AID's EndpointMetadata.base is passed in as-is */
  endpoint: string;
  /** Channel security. Absent = None (anonymous, unsigned) — what most simulators and older field servers offer */
  security?: OpcUaSecurity;
  /** User name sign-in. Absent = anonymous. The password comes from the installer's configuration, never from the AAS */
  user?: { userName: string; password: string };
  /**
   * The reader's certificate store — its own certificate (made on first use) and the server certificates it trusts or
   * has rejected. Required for Sign / SignAndEncrypt.
   * Important: always a folder we name. node-opcua's default store lives in the user's home folder — a service account
   *    home on a factory PC, invisible to whoever has to trust a certificate there.
   */
  pkiDir?: string;
  /**
   * Accept a server certificate never seen before (trust on first use). Default false: an unknown server certificate
   * refuses the connection and waits in `<pkiDir>/rejected` until a person moves it to `<pkiDir>/trusted/certs`.
   */
  trustUnknownServer?: boolean;
  /**
   * Connection timeout (ms). Default 5 s.
   *
   * Important: because of its own retries, node-opcua **hangs for 60 s on an unresponsive address** (measured).
   * One device being off in the field must not push back the whole collection cycle, so we cut it off ourselves.
   */
  connectTimeoutMs?: number;
}

/** Applies a timeout. When it expires, aborts immediately and records the reason */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(fill(tr('{0}이(가) {1}ms 안에 끝나지 않았습니다.'), { 0: what, 1: ms }))), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** DataValue -> our result. The timestamp **provided by the device** takes precedence */
export function toReadResult(source: string, dataValue: DataValue): ReadResult {
  const status = dataValue.statusCode;
  const timestamp = dataValue.sourceTimestamp ?? dataValue.serverTimestamp;
  const result: ReadResult = { source, value: dataValue.value?.value ?? null };

  if (timestamp) result.observedAt = timestamp.toISOString();
  if (status) result.quality = status.name;
  // Not just isNot('Good') — also covers the no-value cases
  if (status && status.value !== 0) {
    if (PENDING_STATUS.has(status.value)) {
      // Important: not arrived yet — not a failure. But it must not masquerade as success either:
      //    clear the value to null so the collector cannot create a sample (no fake values in the time series).
      //    Some states such as `UncertainInitialValue` come with a placeholder value, so always clear it
      result.pending = true;
      result.value = null;
    } else {
      result.error = `${status.name}: ${status.description ?? tr('나쁜 상태')}`;
    }
  }
  return result;
}

/** Report by exception (remote collector, lead request §6 H4) */
export interface SubscribeOptions {
  /** How often the server samples each tag and publishes changes (ms) */
  samplingIntervalMs: number;
  /**
   * Absolute deadband for numeric tags — a change smaller than this is not reported. 0 or absent: every change.
   * Important: only sources listed in `numeric` get it; a deadband on a boolean or text tag is refused by the server
   *    (BadFilterNotAllowed), so those are always reported on any change.
   */
  deadband?: number;
  numeric?: ReadonlySet<string>;
}

export interface ValueSubscription {
  close(): Promise<void>;
}

export class OpcUaReader implements ProtocolReader {
  private constructor(
    readonly base: string,
    private readonly client: OPCUAClient,
    private readonly session: ClientSession,
    private readonly certificates?: OPCUACertificateManager,
  ) {}

  static async connect(options: OpcUaOptions): Promise<OpcUaReader> {
    const timeout = options.connectTimeoutMs ?? 5000;
    const { client, certificates, identity } = await secureClient(options);

    try {
      await withTimeout(client.connect(options.endpoint), timeout, tr('접속'));
      const session = await withTimeout(client.createSession(identity), timeout, tr('세션 열기'));
      return new OpcUaReader(options.endpoint, client, session, certificates);
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      await certificates.dispose().catch(() => undefined);
      throw error instanceof Error
        ? new Error(fill(tr('{0} 접속 실패: {1}'), { 0: options.endpoint, 1: error.message }))
        : error;
    }
  }

  /** Reads a list of addresses (NodeIds) in a single request — a round trip per tag is slow in the field */
  async read(sources: readonly string[]): Promise<ReadResult[]> {
    if (sources.length === 0) return [];

    const nodesToRead = sources.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value }));
    let dataValues: DataValue[];
    try {
      dataValues = await this.session.read(nodesToRead, TimestampsToReturn.Both);
    } catch (error) {
      // Connection lost — mark everything as failed and let the collector decide
      const reason = error instanceof Error ? error.message : String(error);
      return sources.map((source) => ({ source, value: null, error: fill(tr('읽기 실패: {0}'), { 0: reason }) }));
    }

    return sources.map((source, index) => {
      const dataValue = dataValues[index];
      if (!dataValue) return { source, value: null, error: tr('응답이 없습니다.') };
      return toReadResult(source, dataValue);
    });
  }

  /**
   * Subscribes to a list of addresses: the server samples them and reports a value **only when it changes** (beyond the
   * deadband for numeric tags), plus once at the start. Each report goes to `onChange` as the same ReadResult a read
   * gives — device time, quality, pending, error.
   *
   * Important: read only, like `read` — a subscription asks the server to watch values; it writes nothing.
   */
  async subscribe(sources: readonly string[], options: SubscribeOptions, onChange: (result: ReadResult) => void): Promise<ValueSubscription> {
    // Important: the keep-alive (publishing interval × keep-alive count) must stay well inside the session timeout, or
    //    node-opcua refuses the subscription (W09 — measured at a 1 s interval with the 10 s session: 20 × 1 s > 10 s).
    //    Changes are sampled at the tag's interval anyway; publishing may be more frequent than that.
    const sessionMs = this.session.timeout > 0 ? this.session.timeout : 10_000;
    const publishingMs = Math.min(options.samplingIntervalMs, Math.floor(sessionMs / 4));
    const keepAlive = Math.max(1, Math.min(20, Math.floor(sessionMs / 2 / publishingMs)));
    const subscription: ClientSubscription = await this.session.createSubscription2({
      requestedPublishingInterval: publishingMs,
      requestedLifetimeCount: keepAlive * 6,
      requestedMaxKeepAliveCount: keepAlive,
      maxNotificationsPerPublish: 0,
      publishingEnabled: true,
      priority: 1,
    });
    const deadband = options.deadband ?? 0;
    const filtered = deadband > 0 ? sources.filter((source) => options.numeric?.has(source)) : [];
    const plain = sources.filter((source) => !filtered.includes(source));
    const watch = async (list: readonly string[], filter?: DataChangeFilter): Promise<void> => {
      if (list.length === 0) return;
      const group = await subscription.monitorItems(
        list.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })),
        { samplingInterval: options.samplingIntervalMs, discardOldest: true, queueSize: 10, ...(filter ? { filter } : {}) },
        TimestampsToReturn.Both,
      );
      group.on('changed', (_item: ClientMonitoredItemBase, dataValue: DataValue, index: number) => {
        const source = list[index];
        if (source !== undefined) onChange(toReadResult(source, dataValue));
      });
    };
    try {
      await watch(plain);
      await watch(filtered, new DataChangeFilter({ trigger: DataChangeTrigger.StatusValue, deadbandType: DeadbandType.Absolute, deadbandValue: deadband }));
    } catch (error) {
      await subscription.terminate().catch(() => undefined);
      throw error;
    }
    return { close: () => subscription.terminate().catch(() => undefined) };
  }

  async close(): Promise<void> {
    // A failure to close must not break the collection cycle
    await this.session.close().catch(() => undefined);
    await this.client.disconnect().catch(() => undefined);
    await this.certificates?.dispose().catch(() => undefined);
  }
}
