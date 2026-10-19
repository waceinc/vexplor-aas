/**
 * S7 collection adapter — one AID interface (VEXPLOR extension binding, see @aas/collector plc-address.ts) read as the
 * collector's ProtocolReader.
 *
 * Batching: every address becomes one or more pieces (a value longer than a PDU allows is read in chunks), and pieces
 * are packed into as few Read Var requests as the negotiated PDU size and the item limit allow.
 * Isolation: an address that does not parse, or that the CPU answers with an item error (missing DB, out of range),
 * fails alone. A broken connection fails the rest of this read and is dropped — the next read connects again.
 */
import { s7Address, s7Endpoint, type AidInterface, type ProtocolReader, type ReadResult, type S7Address, type S7Endpoint } from '@aas/collector';
import { decodePlcValue } from './plc-value.js';
import { S7_ANSWER_OVERHEAD, S7_MAX_ITEMS, S7_REQUEST_OVERHEAD, S7Client, type S7Item } from './s7-client.js';

export interface S7ReaderOptions {
  timeoutMs?: number;
  /** Inspects the address before connecting (e.g. SSRF blocking in the trial edition). Throws to block */
  guard?: (url: string) => void;
}

interface Piece {
  /** Index into the parsed list */
  owner: number;
  item: S7Item;
}

/** Splits values into pieces of at most `maxBytes` and packs them into requests that fit the PDU */
export function planS7Requests(addresses: readonly S7Address[], pduSize: number): Piece[][] {
  const maxBytes = pduSize - S7_ANSWER_OVERHEAD - 4;
  const pieces: Piece[] = [];
  addresses.forEach((address, owner) => {
    if (address.bit !== undefined) {
      pieces.push({ owner, item: { area: address.area, db: address.db, start: address.offset, bit: address.bit, bytes: 1 } });
      return;
    }
    for (let done = 0; done < address.bytes; done += maxBytes) {
      pieces.push({ owner, item: { area: address.area, db: address.db, start: address.offset + done, bytes: Math.min(maxBytes, address.bytes - done) } });
    }
  });
  const requests: Piece[][] = [];
  let current: Piece[] = [];
  let answer = S7_ANSWER_OVERHEAD;
  for (const piece of pieces) {
    // Each answer item: 4 header bytes + data + one fill byte when the data is odd (counted always — an upper bound)
    const cost = 4 + piece.item.bytes + (piece.item.bytes % 2);
    const request = S7_REQUEST_OVERHEAD + (current.length + 1) * 12;
    if (current.length > 0 && (current.length >= S7_MAX_ITEMS || request > pduSize || answer + cost > pduSize)) {
      requests.push(current);
      current = [];
      answer = S7_ANSWER_OVERHEAD;
    }
    current.push(piece);
    answer += cost;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

export class S7Reader implements ProtocolReader {
  private client: Promise<S7Client> | undefined;

  private constructor(
    private readonly descriptor: AidInterface,
    private readonly options: S7ReaderOptions,
  ) {}

  get base(): string {
    return this.descriptor.base ?? '';
  }

  /** Connects lazily on the first read, like the Modbus reader — an absent device becomes a reason per item */
  static async connect(descriptor: AidInterface, options: S7ReaderOptions = {}): Promise<S7Reader> {
    return new S7Reader(descriptor, options);
  }

  async read(sources: readonly string[]): Promise<ReadResult[]> {
    const results: ReadResult[] = sources.map((source) => ({ source, value: undefined }));
    const parsed: { index: number; address: S7Address }[] = [];
    let endpoint: S7Endpoint;
    try {
      endpoint = s7Endpoint(this.descriptor.base ?? '');
    } catch (error) {
      return results.map((result) => ({ ...result, error: message(error) }));
    }
    sources.forEach((source, index) => {
      try {
        parsed.push({ index, address: s7Address(source) });
      } catch (error) {
        results[index]!.error = message(error);
      }
    });
    if (parsed.length === 0) return results;

    let client: S7Client;
    try {
      client = await this.connected(endpoint);
    } catch (error) {
      for (const { index } of parsed) results[index]!.error = message(error);
      return results;
    }
    const addresses = parsed.map((entry) => entry.address);
    const chunks: (Buffer | undefined)[][] = addresses.map(() => []);
    const failed = new Map<number, string>();
    let broken: string | undefined;
    for (const request of planS7Requests(addresses, client.pduSize)) {
      try {
        if (broken !== undefined) throw new Error(broken);
        const answers = await client.read(request.map((piece) => piece.item));
        request.forEach((piece, at) => {
          const answer = answers[at];
          if (answer?.error !== undefined) failed.set(piece.owner, answer.error);
          else chunks[piece.owner]!.push(answer?.data);
        });
      } catch (error) {
        for (const piece of request) failed.set(piece.owner, message(error));
        if (!client.alive) broken ??= message(error);
      }
    }
    if (!client.alive) this.client = undefined;

    parsed.forEach(({ index, address }, owner) => {
      const reason = failed.get(owner);
      if (reason !== undefined) {
        results[index]!.error = reason;
        return;
      }
      const data = Buffer.concat(chunks[owner]!.filter((chunk): chunk is Buffer => chunk !== undefined));
      try {
        if (data.length < (address.bit !== undefined ? 1 : address.bytes)) throw new Error('ShortAnswer');
        const value = address.bit !== undefined ? data[0] !== 0 : decodePlcValue(data, address, false, 'S7');
        Object.assign(results[index]!, { value, quality: 'Good' });
      } catch (error) {
        results[index]!.error = message(error);
      }
    });
    return results;
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    await (await pending?.catch(() => undefined))?.close();
  }

  private async connected(endpoint: S7Endpoint): Promise<S7Client> {
    const existing = await this.client?.catch(() => undefined);
    if (existing?.alive) return existing;
    this.options.guard?.(`s7://${endpoint.host}:${endpoint.port}`);
    const next = S7Client.connect(endpoint, this.options.timeoutMs);
    this.client = next;
    // A failed connection is dropped so the next read retries
    next.catch(() => {
      if (this.client === next) this.client = undefined;
    });
    return next;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
