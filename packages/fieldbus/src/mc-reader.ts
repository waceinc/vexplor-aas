/**
 * MC protocol collection adapter — one AID interface (VEXPLOR extension binding, see @aas/collector plc-address.ts)
 * read as the collector's ProtocolReader.
 *
 * Batching: addresses on the same device are merged into one Batch Read when they lie close together (a few unused
 * words cost less than another round trip), within the frame's point limits. Bit devices are read in bit units,
 * word devices (and bits of a word, `D10.3`) in word units.
 * Isolation: when a merged read is refused (e.g. one address past the end of the device), each address in it is read
 * again on its own, so only the bad one fails. A broken connection fails the rest of this read and is dropped.
 */
import { MC_DEVICE_CODE, mcAddress, mcEndpoint, type AidInterface, type McAddress, type McEndpoint, type ProtocolReader, type ReadResult } from '@aas/collector';
import { MC_MAX_BITS, MC_MAX_WORDS, McClient } from './mc-client.js';
import { decodePlcValue } from './plc-value.js';

export interface McReaderOptions {
  timeoutMs?: number;
  /** Inspects the address before connecting (e.g. SSRF blocking in the trial edition). Throws to block */
  guard?: (url: string) => void;
}

/** Unused points we accept reading between two addresses rather than sending a second request */
const MERGE_GAP = 16;

export interface McBlock {
  code: number;
  bits: boolean;
  start: number;
  points: number;
  /** Indexes into the address list this block answers */
  members: number[];
}

/** Groups addresses by device and unit, then merges neighbours into blocks within the 3E point limits */
export function planMcBlocks(addresses: readonly McAddress[]): McBlock[] {
  const groups = new Map<string, number[]>();
  addresses.forEach((address, index) => {
    const key = `${address.device}:${address.bitDevice ? 'bit' : 'word'}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const blocks: McBlock[] = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort((a, b) => addresses[a]!.number - addresses[b]!.number);
    let block: McBlock | undefined;
    for (const index of sorted) {
      const address = addresses[index]!;
      const limit = address.bitDevice ? MC_MAX_BITS : MC_MAX_WORDS;
      const end = address.number + address.points;
      if (block && address.number <= block.start + block.points + MERGE_GAP && Math.max(end, block.start + block.points) - block.start <= limit) {
        block.points = Math.max(end, block.start + block.points) - block.start;
        block.members.push(index);
        continue;
      }
      block = { code: MC_DEVICE_CODE[address.device], bits: address.bitDevice, start: address.number, points: address.points, members: [index] };
      blocks.push(block);
    }
  }
  return blocks;
}

export class McReader implements ProtocolReader {
  private client: Promise<McClient> | undefined;

  private constructor(
    private readonly descriptor: AidInterface,
    private readonly options: McReaderOptions,
  ) {}

  get base(): string {
    return this.descriptor.base ?? '';
  }

  /** Connects lazily on the first read, like the Modbus reader — an absent device becomes a reason per item */
  static async connect(descriptor: AidInterface, options: McReaderOptions = {}): Promise<McReader> {
    return new McReader(descriptor, options);
  }

  async read(sources: readonly string[]): Promise<ReadResult[]> {
    const results: ReadResult[] = sources.map((source) => ({ source, value: undefined }));
    let endpoint: McEndpoint;
    try {
      endpoint = mcEndpoint(this.descriptor.base ?? '');
    } catch (error) {
      return results.map((result) => ({ ...result, error: message(error) }));
    }
    const parsed: { index: number; address: McAddress }[] = [];
    sources.forEach((source, index) => {
      try {
        parsed.push({ index, address: mcAddress(source, endpoint.series) });
      } catch (error) {
        results[index]!.error = message(error);
      }
    });
    if (parsed.length === 0) return results;

    let client: McClient;
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
    let broken: string | undefined;
    const readBlock = async (block: McBlock): Promise<void> => {
      if (broken !== undefined) throw new Error(broken);
      try {
        if (block.bits) {
          const bits = await client.readBits(block.code, block.start, block.points);
          for (const member of block.members) put(member, { value: bits[addresses[member]!.number - block.start] });
          return;
        }
        const words = await client.readWords(block.code, block.start, block.points);
        for (const member of block.members) {
          const address = addresses[member]!;
          const at = (address.number - block.start) * 2;
          const slice = words.subarray(at, at + address.points * 2);
          try {
            put(member, { value: address.bit !== undefined ? ((slice.readUInt16LE(0) >> address.bit) & 1) === 1 : decodePlcValue(slice, address, true, 'MC') });
          } catch (error) {
            put(member, { error: message(error) });
          }
        }
      } catch (error) {
        if (!client.alive) broken ??= message(error);
        throw error;
      }
    };
    for (const block of planMcBlocks(addresses)) {
      try {
        await readBlock(block);
      } catch (error) {
        // Read each address alone so only the one that is really out of range fails
        if (block.members.length > 1 && broken === undefined) {
          for (const member of block.members) {
            const address = addresses[member]!;
            const single: McBlock = { code: block.code, bits: block.bits, start: address.number, points: address.points, members: [member] };
            await readBlock(single).catch((inner: unknown) => put(member, { error: message(inner) }));
          }
        } else {
          for (const member of block.members) put(member, { error: message(error) });
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

  private async connected(endpoint: McEndpoint): Promise<McClient> {
    const existing = await this.client?.catch(() => undefined);
    if (existing?.alive) return existing;
    this.options.guard?.(`melsec://${endpoint.host}:${endpoint.port}`);
    const next = McClient.connect(endpoint, this.options.timeoutMs);
    this.client = next;
    // A failed connection is dropped so the next read retries
    next.catch(() => {
      if (this.client === next) this.client = undefined;
    });
    return next;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
