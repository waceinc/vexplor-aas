/**
 * Test Modbus TCP device — answers only the four read functions. Used for tests and virtual equipment (instead of real hardware).
 * Values are loaded as tables (address -> value). Addresses beyond maxAddress get an IllegalDataAddress exception (like real hardware).
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { ModbusEntity } from './modbus-target.js';

const ENTITY_OF: Record<number, ModbusEntity> = { 1: 'Coil', 2: 'DiscreteInput', 3: 'HoldingRegister', 4: 'InputRegister' };

export class ModbusTestServer {
  readonly tables: Record<ModbusEntity, Map<number, number>> = {
    Coil: new Map(),
    DiscreteInput: new Map(),
    HoldingRegister: new Map(),
    InputRegister: new Map(),
  };
  /** Number of requests received — checked when testing batched reads and reconnects */
  requests = 0;
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly maxAddress = 9999) {}

  /** 0 picks a free port. Returns the opened port */
  listen(port = 0): Promise<number> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 7 && buffer.length >= 6 + buffer.readUInt16BE(4)) {
          const total = 6 + buffer.readUInt16BE(4);
          const frame = buffer.subarray(0, total);
          buffer = buffer.subarray(total);
          socket.write(this.answer(frame));
        }
      });
    });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve((this.server!.address() as { port: number }).port)));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private answer(frame: Buffer): Buffer {
    this.requests += 1;
    const fc = frame[7]!;
    const address = frame.readUInt16BE(8);
    const quantity = frame.readUInt16BE(10);
    const entity = ENTITY_OF[fc];
    let pdu: Buffer;
    if (!entity) pdu = Buffer.from([fc | 0x80, 1]);
    else if (address + quantity - 1 > this.maxAddress) pdu = Buffer.from([fc | 0x80, 2]);
    else if (entity === 'Coil' || entity === 'DiscreteInput') {
      const bytes = Buffer.alloc(Math.ceil(quantity / 8));
      for (let i = 0; i < quantity; i += 1) if (this.tables[entity].get(address + i)) bytes[i >> 3]! |= 1 << (i & 7);
      pdu = Buffer.concat([Buffer.from([fc, bytes.length]), bytes]);
    } else {
      const data = Buffer.alloc(quantity * 2);
      for (let i = 0; i < quantity; i += 1) data.writeUInt16BE((this.tables[entity].get(address + i) ?? 0) & 0xffff, i * 2);
      pdu = Buffer.concat([Buffer.from([fc, data.length]), data]);
    }
    const header = Buffer.alloc(7);
    frame.copy(header, 0, 0, 4);
    header.writeUInt16BE(pdu.length + 1, 4);
    header[6] = frame[6]!;
    return Buffer.concat([header, pdu]);
  }
}
