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
  OPCUAClient,
  StatusCodes,
  TimestampsToReturn,
  type ClientSession,
  type DataValue,
} from 'node-opcua';

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

export class OpcUaReader implements ProtocolReader {
  private constructor(
    readonly base: string,
    private readonly client: OPCUAClient,
    private readonly session: ClientSession,
  ) {}

  static async connect(options: OpcUaOptions): Promise<OpcUaReader> {
    const timeout = options.connectTimeoutMs ?? 5000;
    const client = OPCUAClient.create({
      // Field equipment often does not report an accurate endpoint list.
      // We may also be unable to resolve the hostname the server advertises (.local, etc.), so the address is used as-is
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 0, initialDelay: 200, maxDelay: 1000 },
      requestedSessionTimeout: Math.max(timeout, 10_000),
    });

    try {
      await withTimeout(client.connect(options.endpoint), timeout, tr('접속'));
      const session = await withTimeout(client.createSession(), timeout, tr('세션 열기'));
      return new OpcUaReader(options.endpoint, client, session);
    } catch (error) {
      await client.disconnect().catch(() => undefined);
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

  async close(): Promise<void> {
    // A failure to close must not break the collection cycle
    await this.session.close().catch(() => undefined);
    await this.client.disconnect().catch(() => undefined);
  }
}
