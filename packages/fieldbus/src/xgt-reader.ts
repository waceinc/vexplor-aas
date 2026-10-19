/**
 * XGT dedicated protocol collection adapter — one AID interface (VEXPLOR extension binding, see @aas/collector
 * xgt-address.ts) read as the collector's ProtocolReader.
 *
 * Batching: flat addresses on the same device are merged into one continuous byte read (`%DB200`, up to 1,400 bytes)
 * when they lie close together; I / Q (`%IX0.0.3`) and T / C contacts are read by name, up to 16 of one size letter per
 * request (the manual's individual read).
 * Isolation: when a merged or grouped read is refused (e.g. one address past the end of the device), each address in it
 * is read again on its own, so only the bad one fails. A broken connection fails the rest of this read and is dropped.
 */
import { XGT_MAX_BLOCKS, XGT_MAX_BYTES, xgtAddress, xgtEndpoint, type AidInterface, type ProtocolReader, type ReadResult, type XgtAddress, type XgtEndpoint } from '@aas/collector';
import { decodePlcValue } from './plc-value.js';
import { XgtClient } from './xgt-client.js';

export interface XgtReaderOptions {
  timeoutMs?: number;
  /** Inspects the address before connecting (e.g. SSRF blocking in the trial edition). Throws to block */
  guard?: (url: string) => void;
}

/** Unused bytes we accept reading between two addresses rather than sending a second request */
const MERGE_GAP = 32;

export type XgtRequest =
  | { kind: 'block'; device: string; start: number; bytes: number; members: number[] }
  | { kind: 'single'; size: 'X' | 'B' | 'W' | 'D' | 'L'; members: number[] };

/** Continuous reads per device (merged neighbours within 1,400 bytes), then individual reads of ≤ 16 per size letter */
export function planXgtRequests(addresses: readonly XgtAddress[], maxBytes = XGT_MAX_BYTES): XgtRequest[] {
  const devices = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  addresses.forEach((address, index) => {
    const map = address.mode === 'block' ? devices : sizes;
    const key = address.mode === 'block' ? address.device : address.size;
    map.set(key, [...(map.get(key) ?? []), index]);
  });
  const requests: XgtRequest[] = [];
  const at = (index: number): number => (addresses[index] as Extract<XgtAddress, { mode: 'block' }>).byte;
  for (const [device, members] of devices) {
    let block: Extract<XgtRequest, { kind: 'block' }> | undefined;
    for (const index of [...members].sort((a, b) => at(a) - at(b))) {
      const start = at(index);
      const end = start + addresses[index]!.bytes;
      if (block && start <= block.start + block.bytes + MERGE_GAP && Math.max(end, block.start + block.bytes) - block.start <= maxBytes) {
        block.bytes = Math.max(end, block.start + block.bytes) - block.start;
        block.members.push(index);
        continue;
      }
      block = { kind: 'block', device, start, bytes: addresses[index]!.bytes, members: [index] };
      requests.push(block);
    }
  }
  for (const [size, members] of sizes) {
    for (let i = 0; i < members.length; i += XGT_MAX_BLOCKS) {
      requests.push({ kind: 'single', size: size as Extract<XgtRequest, { kind: 'single' }>['size'], members: members.slice(i, i + XGT_MAX_BLOCKS) });
    }
  }
  return requests;
}

export class XgtReader implements ProtocolReader {
  private client: Promise<XgtClient> | undefined;

  private constructor(
    private readonly descriptor: AidInterface,
    private readonly options: XgtReaderOptions,
  ) {}

  get base(): string {
    return this.descriptor.base ?? '';
  }

  /** Connects lazily on the first read, like the MC reader — an absent device becomes a reason per item */
  static async connect(descriptor: AidInterface, options: XgtReaderOptions = {}): Promise<XgtReader> {
    return new XgtReader(descriptor, options);
  }

  async read(sources: readonly string[]): Promise<ReadResult[]> {
    const results: ReadResult[] = sources.map((source) => ({ source, value: undefined }));
    let endpoint: XgtEndpoint;
    try {
      endpoint = xgtEndpoint(this.descriptor.base ?? '');
    } catch (error) {
      return results.map((result) => ({ ...result, error: message(error) }));
    }
    const parsed: { index: number; address: XgtAddress }[] = [];
    sources.forEach((source, index) => {
      try {
        parsed.push({ index, address: xgtAddress(source, endpoint.series) });
      } catch (error) {
        results[index]!.error = message(error);
      }
    });
    if (parsed.length === 0) return results;

    let client: XgtClient;
    try {
      client = await this.connected(endpoint);
    } catch (error) {
      for (const { index } of parsed) results[index]!.error = message(error);
      return results;
    }
    const addresses = parsed.map((entry) => entry.address);
    const put = (member: number, outcome: { value?: unknown; error?: string }): void => {
      const result = results[parsed[member]!.index]!;
      if (outcome.error !== undefined) result.error = outcome.error;
      else Object.assign(result, { value: outcome.value, quality: 'Good' });
    };
    const decode = (address: XgtAddress, bytes: Buffer, bit: number | undefined): unknown =>
      address.type === 'BOOL' ? ((bytes[0]! >> (bit ?? 0)) & 1) === 1 : decodePlcValue(bytes, address, true, 'XGT');
    let broken: string | undefined;
    const run = async (request: XgtRequest): Promise<void> => {
      if (broken !== undefined) throw new Error(broken);
      try {
        if (request.kind === 'block') {
          const data = await client.readBytes(request.device, request.start, request.bytes);
          for (const member of request.members) {
            const address = addresses[member] as Extract<XgtAddress, { mode: 'block' }>;
            const offset = address.byte - request.start;
            try {
              put(member, { value: decode(address, data.subarray(offset, offset + address.bytes), address.bit) });
            } catch (error) {
              put(member, { error: message(error) });
            }
          }
          return;
        }
        const names = request.members.map((member) => (addresses[member] as Extract<XgtAddress, { mode: 'single' }>).name);
        const blocks = await client.readVariables(request.size, names);
        request.members.forEach((member, i) => {
          try {
            // A bit answers in one byte, only its lowest bit counts (§8.2.1 p.8-8)
            put(member, { value: decode(addresses[member]!, blocks[i]!, 0) });
          } catch (error) {
            put(member, { error: message(error) });
          }
        });
      } catch (error) {
        if (!client.alive) broken ??= message(error);
        throw error;
      }
    };
    for (const request of planXgtRequests(addresses)) {
      try {
        await run(request);
      } catch (error) {
        // Read each address alone so only the one that is really refused fails
        if (request.members.length > 1 && broken === undefined) {
          for (const member of request.members) {
            const address = addresses[member]!;
            const single: XgtRequest =
              address.mode === 'block'
                ? { kind: 'block', device: address.device, start: address.byte, bytes: address.bytes, members: [member] }
                : { kind: 'single', size: address.size, members: [member] };
            await run(single).catch((inner: unknown) => put(member, { error: message(inner) }));
          }
        } else {
          for (const member of request.members) put(member, { error: message(error) });
        }
      }
    }
    if (!client.alive) this.client = undefined;
    return results;
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    await (await pending?.catch(() => undefined))?.close();
  }

  private async connected(endpoint: XgtEndpoint): Promise<XgtClient> {
    const existing = await this.client?.catch(() => undefined);
    if (existing?.alive) return existing;
    this.options.guard?.(`xgt://${endpoint.host}:${endpoint.port}`);
    const next = XgtClient.connect(endpoint, this.options.timeoutMs);
    this.client = next;
    // A failed connection is dropped so the next read retries
    next.catch(() => {
      if (this.client === next) this.client = undefined;
    });
    return next;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
