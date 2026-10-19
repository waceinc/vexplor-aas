/**
 * Test-only LS ELECTRIC XGT CPU behind a FEnet module — answers the XGT dedicated protocol read request (0x0054) from
 * device tables. Lives in the test folder: it is not part of the product and not exported by @aas/fieldbus.
 *
 * Built from the published manuals only — "XGT FEnet I/F Module User's Manual" V2.30 ch. 8 and §10.4, "XGB FEnet I/F
 * Module" V1.5 §5.2 — not from a captured CPU:
 *   header (20)  "LSIS-XGT" 00 00 · PLC info · CPU info · source (0x33 asks, 0x11 answers) · invoke id · length
 *                · position · BCC (byte sum of bytes 0–18; a wrong one is answered with error 0x0077)
 *   read         0x0054 · type (00 X · 01 B · 02 W · 03 D · 04 L, 0x14 continuous) · 0000 · blocks · (len, name)…
 *                · continuous: one block and a byte count ≤ 1,400
 *   answer       0x0055 · type · 0000 · error status 0000 · blocks · (size, data)…
 *                NAK: error status FFFF · error code (2 bytes, or 1 byte with `nakOneByte` — chapter 8 shows that form)
 * Error codes used: 0001 too many blocks · 0002 type · 0003 device · 0004 range · 0005 size · 0076 length · 0077 BCC
 * · 0078 instruction. Requests that break a published limit are also counted in `violations`.
 */
import { createServer, type Server, type Socket } from 'node:net';

const SIZE: Record<string, number> = { X: 0, B: 1, W: 2, D: 3, L: 4 };
const WIDTH = [1, 1, 2, 4, 8];

export class XgtMockServer {
  /** Device letter → its bytes (flat devices: M D P … and XGI M R W …) */
  readonly memory = new Map<string, Buffer>();
  /** T / C contacts (bit numbers that are on) — a separate area from the current values in `memory` */
  readonly contacts = new Map<string, Set<number>>([
    ['T', new Set()],
    ['C', new Set()],
  ]);
  /** I / Q variables by name (`%IX0.0.3` → its bytes) — base.slot.number has no flat address */
  readonly io = new Map<string, Buffer>();
  requests = 0;
  connections = 0;
  violations: string[] = [];
  /** CPU info byte of the last request */
  cpuInfo: number | undefined;
  /** Every variable name asked for, in order */
  readonly names: string[] = [];
  silent = false;
  nakOneByte = false;
  /** Answer the next request with an invoke id that does not match */
  wrongInvoke = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(devices: readonly string[] = ['P', 'M', 'K', 'F', 'T', 'C', 'L', 'N', 'D', 'R', 'W'], bytes = 2048) {
    for (const device of devices) this.memory.set(device, Buffer.alloc(bytes));
  }

  listen(): Promise<number> {
    this.server = createServer((socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 20 && buffer.length >= 20 + buffer.readUInt16LE(16)) {
          const frame = buffer.subarray(0, 20 + buffer.readUInt16LE(16));
          buffer = buffer.subarray(frame.length);
          if (!this.silent) socket.write(this.answer(frame));
        }
      });
    });
    return new Promise((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve((this.server!.address() as { port: number }).port)));
  }

  drop(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private answer(frame: Buffer): Buffer {
    this.requests += 1;
    this.cpuInfo = frame[12];
    const invoke = this.wrongInvoke ? (frame.readUInt16LE(14) + 1) & 0xffff : frame.readUInt16LE(14);
    this.wrongInvoke = false;
    const type = frame.length >= 24 ? frame.readUInt16LE(22) : 0;
    const nak = (code: number): Buffer => {
      const body = Buffer.alloc(this.nakOneByte ? 9 : 10);
      body.writeUInt16LE(0x0055, 0);
      body.writeUInt16LE(type, 2);
      body.writeUInt16LE(0xffff, 6);
      if (this.nakOneByte) body[8] = code;
      else body.writeUInt16LE(code, 8);
      return wrap(invoke, body);
    };
    if (!frame.subarray(0, 10).equals(Buffer.from('LSIS-XGT\0\0', 'latin1')) || frame[13] !== 0x33) return nak(0x0075);
    let sum = 0;
    for (let i = 0; i < 19; i += 1) sum += frame[i]!;
    if ((sum & 0xff) !== frame[19]) return nak(0x0077);
    if (frame.readUInt16LE(16) !== frame.length - 20 || frame.length < 28) return nak(0x0076);
    if (frame.readUInt16LE(20) !== 0x0054) {
      this.violations.push(`instruction 0x${frame.readUInt16LE(20).toString(16)}`);
      return nak(0x0078);
    }
    const blocks = frame.readUInt16LE(26);
    const names: string[] = [];
    let at = 28;
    for (let i = 0; i < blocks; i += 1) {
      const length = frame.readUInt16LE(at);
      if (length < 1 || length > 16) this.violations.push(`name of ${length} characters`);
      names.push(frame.subarray(at + 2, at + 2 + length).toString('latin1'));
      at += 2 + length;
    }
    this.names.push(...names);
    if (type === 0x14) {
      const count = frame.readUInt16LE(at);
      if (blocks !== 1) return nak(0x0001);
      if (count > 1400) {
        this.violations.push(`continuous read of ${count} bytes`);
        return nak(0x0005);
      }
      const match = /^%([A-Z])B(\d+)$/.exec(names[0] ?? '');
      if (!match) return nak(0x0002);
      const table = this.memory.get(match[1]!);
      if (!table) return nak(0x0003);
      const start = Number(match[2]);
      if (start + count > table.length) return nak(0x0004);
      return ok(invoke, type, [table.subarray(start, start + count)]);
    }
    if (blocks < 1 || blocks > 16) {
      this.violations.push(`individual read of ${blocks} blocks`);
      return nak(0x0001);
    }
    if (type > 4) return nak(0x0002);
    const data: Buffer[] = [];
    for (const name of names) {
      const value = this.variable(name, type);
      if (typeof value === 'number') return nak(value);
      data.push(value);
    }
    return ok(invoke, type, data);
  }

  /** One variable of an individual read, or the error code that refuses the whole request */
  private variable(name: string, type: number): Buffer | number {
    const io = /^%([IQ])([XBWDL])\d+\.\d+\.\d+$/.exec(name);
    if (io) {
      if (SIZE[io[2]!] !== type) return 0x0002;
      return this.io.get(name) ?? 0x0004;
    }
    const match = /^%([A-Z])([XBWDL])(\d+)$/.exec(name);
    if (!match || SIZE[match[2]!] !== type) return 0x0002;
    const number = Number(match[3]);
    const contacts = this.contacts.get(match[1]!);
    if (contacts && type === 0) return number < 2048 ? Buffer.from([contacts.has(number) ? 1 : 0]) : 0x0004;
    const table = this.memory.get(match[1]!);
    if (!table) return 0x0003;
    if (type === 0) return Math.floor(number / 8) < table.length ? Buffer.from([(table[Math.floor(number / 8)]! >> number % 8) & 1]) : 0x0004;
    const start = number * WIDTH[type]!;
    return start + WIDTH[type]! <= table.length ? Buffer.from(table.subarray(start, start + WIDTH[type]!)) : 0x0004;
  }
}

function ok(invoke: number, type: number, blocks: Buffer[]): Buffer {
  const body = Buffer.alloc(10 + blocks.reduce((sum, block) => sum + 2 + block.length, 0));
  body.writeUInt16LE(0x0055, 0);
  body.writeUInt16LE(type, 2);
  body.writeUInt16LE(blocks.length, 8);
  let at = 10;
  for (const block of blocks) {
    body.writeUInt16LE(block.length, at);
    block.copy(body, at + 2);
    at += 2 + block.length;
  }
  return wrap(invoke, body);
}

/** Answer header — PLC info "RUN, XGK-CPUH" (01 01), CPU info XGK, source 0x11 */
function wrap(invoke: number, body: Buffer): Buffer {
  const out = Buffer.alloc(20 + body.length);
  out.write('LSIS-XGT', 0, 'latin1');
  out.writeUInt16LE(0x0101, 10);
  out[12] = 0xa0;
  out[13] = 0x11;
  out.writeUInt16LE(invoke, 14);
  out.writeUInt16LE(body.length, 16);
  let sum = 0;
  for (let i = 0; i < 19; i += 1) sum += out[i]!;
  out[19] = sum & 0xff;
  body.copy(out, 20);
  return out;
}
