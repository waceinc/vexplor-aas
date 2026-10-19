/**
 * Test-only S7 CPU — answers ISO-on-TCP connect, Setup Communication and Read Var from memory tables.
 * Lives in the test folder: it is not part of the product and not exported by @aas/fieldbus.
 *
 * Frames follow the published layers the client implements:
 *   TPKT   RFC 1006 §6 — 03 00 + 16-bit total length
 *   COTP   ISO 8073 (ITU-T X.224) §13.3 CR 0xE0, §13.4 CC 0xD0, §13.5 DR 0x80, §13.7 DT 0xF0 (EOT bit 0x80)
 *   S7comm header 0x32 · ROSCTR 1 Job / 3 Ack_Data · Setup Communication 0xF0 · Read Var 0x04 with 12-byte ANY items,
 *          item return codes 0xFF/0x05/0x0A — field layout per the Wireshark S7comm dissector (packet-s7comm.c)
 * It also enforces what a real CPU enforces and the client must respect: the negotiated PDU size and 20 items.
 */
import { createServer, type Server, type Socket } from 'node:net';

const AREA: Record<number, 'I' | 'Q' | 'M' | 'DB'> = { 0x81: 'I', 0x82: 'Q', 0x83: 'M', 0x84: 'DB' };

export class S7MockServer {
  readonly dbs = new Map<number, Buffer>();
  readonly areas = { I: Buffer.alloc(64), Q: Buffer.alloc(64), M: Buffer.alloc(256) };
  /** Read Var requests answered — checked when testing batching */
  readRequests = 0;
  /** Requests or answers that broke the negotiated PDU size or the item limit — must stay 0 */
  violations = 0;
  connections = 0;
  /** Answer every Read Var with this header error (e.g. 0x8104 = PUT/GET access off) */
  refuse: number | undefined;
  /** Stop answering (to test timeouts) */
  silent = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly options: { pduSize?: number; rack?: number; slot?: number } = {},
  ) {}

  listen(): Promise<number> {
    this.server = createServer((socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      let pdu = 240;
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt16BE(2)) {
          const frame = buffer.subarray(0, buffer.readUInt16BE(2));
          buffer = buffer.subarray(frame.length);
          if (this.silent) continue;
          const answer = this.answer(frame, pdu, (negotiated) => (pdu = negotiated));
          if (answer) socket.write(answer);
        }
      });
    });
    return new Promise((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve((this.server!.address() as { port: number }).port)));
  }

  /** Cuts every open connection, as a cable pull or a CPU restart would */
  drop(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private answer(frame: Buffer, pdu: number, setPdu: (size: number) => void): Buffer | undefined {
    const cotpType = frame[5];
    if (cotpType === 0xe0) {
      // Called TSAP (C2) is the last parameter: low byte = rack × 32 + slot
      const tsap = frame[frame.length - 1]!;
      const wanted = ((this.options.rack ?? 0) << 5) | (this.options.slot ?? 1);
      if (tsap !== wanted) return tpkt(Buffer.from([0x06, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00]));
      return tpkt(Buffer.from([0x11, 0xd0, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, tsap]));
    }
    if (cotpType !== 0xf0) return undefined;
    const s7 = frame.subarray(7);
    const ref = s7.readUInt16BE(4);
    const fn = s7[10];
    if (fn === 0xf0) {
      const size = Math.min(s7.readUInt16BE(16), this.options.pduSize ?? 240);
      setPdu(size);
      const params = Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, size >> 8, size & 0xff]);
      return tpkt(Buffer.concat([DT, ackHeader(ref, params.length, 0, 0), params]));
    }
    if (fn !== 0x04) return undefined;
    this.readRequests += 1;
    const count = s7[11]!;
    if (s7.length > pdu || count > 20) this.violations += 1;
    if (this.refuse !== undefined) return tpkt(Buffer.concat([DT, ackHeader(ref, 0, 0, this.refuse)]));
    const items: Buffer[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = 12 + index * 12;
      const transport = s7[at + 3]!;
      const length = s7.readUInt16BE(at + 4);
      const db = s7.readUInt16BE(at + 6);
      const area = AREA[s7[at + 8]!];
      const address = (s7[at + 9]! << 16) | (s7[at + 10]! << 8) | s7[at + 11]!;
      const memory = area === 'DB' ? this.dbs.get(db) : area ? this.areas[area] : undefined;
      const start = address >> 3;
      const bytes = transport === 0x01 ? 1 : length;
      let item: Buffer;
      if (!memory) item = Buffer.from([0x0a, 0x00, 0x00, 0x00]);
      else if (start + bytes > memory.length) item = Buffer.from([0x05, 0x00, 0x00, 0x00]);
      else if (transport === 0x01) item = Buffer.from([0xff, 0x03, 0x00, 0x01, (memory[start]! >> (address & 7)) & 1]);
      else {
        const head = Buffer.from([0xff, 0x04, 0x00, 0x00]);
        head.writeUInt16BE(bytes * 8, 2);
        item = Buffer.concat([head, memory.subarray(start, start + bytes)]);
      }
      // Fill byte after odd-length data, except after the last item
      if ((item.length - 4) % 2 === 1 && index < count - 1) item = Buffer.concat([item, Buffer.from([0])]);
      items.push(item);
    }
    const data = Buffer.concat(items);
    const answer = Buffer.concat([ackHeader(ref, 2, data.length, 0), Buffer.from([0x04, count]), data]);
    if (answer.length > pdu) this.violations += 1;
    return tpkt(Buffer.concat([DT, answer]));
  }
}

const DT = Buffer.from([0x02, 0xf0, 0x80]);

function tpkt(payload: Buffer): Buffer {
  const header = Buffer.from([0x03, 0x00, 0x00, 0x00]);
  header.writeUInt16BE(payload.length + 4, 2);
  return Buffer.concat([header, payload]);
}

/** Ack_Data header: 12 bytes, the last two are error class and code */
function ackHeader(ref: number, paramLength: number, dataLength: number, error: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x32;
  header[1] = 0x03;
  header.writeUInt16BE(ref, 4);
  header.writeUInt16BE(paramLength, 6);
  header.writeUInt16BE(dataLength, 8);
  header.writeUInt16BE(error, 10);
  return header;
}
