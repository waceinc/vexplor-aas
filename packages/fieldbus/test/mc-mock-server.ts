/**
 * Test-only MELSEC CPU — answers MC protocol 3E binary Batch Read (0x0401) from device tables.
 * Lives in the test folder: it is not part of the product and not exported by @aas/fieldbus.
 *
 * Frames follow the vendor's published "MELSEC Communication Protocol Reference Manual" (3E frame message format,
 * Batch read in word units 0000 / bit units 0001) and the SLMP reference for iQ-R / iQ-F, which uses the same frame:
 *   request  50 00 · net · PC · FF 03 · 00 · length LE · timer LE · 01 04 · subcommand LE · number (3 LE) · code · points LE
 *   answer   D0 00 · net · PC · FF 03 · 00 · length LE · end code LE · data | 9 bytes of error information
 * Word data is little-endian per word; bit-unit data packs two points per byte, the first in the high nibble.
 * End codes used: C056 (address out of range), C051 (too many points), C059 (command not supported).
 */
import { createServer, type Server, type Socket } from 'node:net';

/** Device code → kind and size (points). Codes per the 3E device code table */
const DEVICES: Record<number, { bit: boolean }> = { 0xa8: { bit: false }, 0xb4: { bit: false }, 0xaf: { bit: false }, 0x90: { bit: true }, 0x9c: { bit: true }, 0x9d: { bit: true } };

export class McMockServer {
  /** Device code → values (words for word devices, 0/1 for bit devices) */
  readonly memory = new Map<number, number[]>();
  /** Batch Read requests answered */
  requests = 0;
  connections = 0;
  silent = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly size = 1024) {
    for (const code of Object.keys(DEVICES)) this.memory.set(Number(code), new Array<number>(size).fill(0));
  }

  /** Writes words (little-endian bytes as the PLC holds them) starting at a word device number */
  setBytes(code: number, number: number, bytes: Buffer): void {
    const table = this.memory.get(code)!;
    for (let i = 0; i < bytes.length; i += 2) table[number + i / 2] = bytes[i]! | ((bytes[i + 1] ?? 0) << 8);
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
        while (buffer.length >= 9 && buffer.length >= 9 + buffer.readUInt16LE(7)) {
          const frame = buffer.subarray(0, 9 + buffer.readUInt16LE(7));
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
    const head = frame.subarray(2, 7);
    const command = frame.readUInt16LE(11);
    const subcommand = frame.readUInt16LE(13);
    const number = frame.readUIntLE(15, 3);
    const code = frame[18]!;
    const points = frame.readUInt16LE(19);
    const fail = (end: number): Buffer => {
      const info = Buffer.concat([head, frame.subarray(11, 15)]);
      return reply(head, end, info);
    };
    const device = DEVICES[code];
    const table = this.memory.get(code);
    if (frame.readUInt16LE(0) !== 0x0050 || command !== 0x0401 || !device || !table) return fail(0xc059);
    if (subcommand === 0x0001) {
      if (!device.bit) return fail(0xc059);
      if (points > 7168) return fail(0xc051);
      if (number + points > this.size) return fail(0xc056);
      const data = Buffer.alloc(Math.ceil(points / 2));
      for (let i = 0; i < points; i += 1) if (table[number + i]) data[i >> 1]! |= i % 2 === 0 ? 0x10 : 0x01;
      return reply(head, 0, data);
    }
    if (subcommand !== 0x0000) return fail(0xc059);
    if (points > 960) return fail(0xc051);
    // A bit device read in word units packs 16 points per word, the lowest number in bit 0
    const span = device.bit ? points * 16 : points;
    if (number + span > this.size) return fail(0xc056);
    const data = Buffer.alloc(points * 2);
    for (let i = 0; i < points; i += 1) {
      let word = 0;
      if (device.bit) for (let b = 0; b < 16; b += 1) word |= (table[number + i * 16 + b] ? 1 : 0) << b;
      else word = table[number + i]!;
      data.writeUInt16LE(word & 0xffff, i * 2);
    }
    return reply(head, 0, data);
  }
}

function reply(head: Buffer, end: number, data: Buffer): Buffer {
  const out = Buffer.alloc(11 + data.length);
  out.writeUInt16LE(0x00d0, 0);
  head.copy(out, 2);
  out.writeUInt16LE(2 + data.length, 7);
  out.writeUInt16LE(end, 9);
  data.copy(out, 11);
  return out;
}
