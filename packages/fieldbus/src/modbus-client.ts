/**
 * Modbus TCP client — only the four read functions (01 coils, 02 discrete inputs, 03 holding registers, 04 input registers).
 *
 * No writes — this tool **only fetches** equipment values (collection option A). Requests are sent with an MBAP header
 * (transaction id, length, unit), and responses are matched by transaction id. If the device answers with an exception
 * (function code + 0x80), its name is returned as the reason.
 */
import { Socket } from 'node:net';
import { fill, tr } from '@aas/core';
import type { ModbusEntity } from './modbus-target.js';

const FUNCTION: Record<ModbusEntity, number> = { Coil: 1, DiscreteInput: 2, HoldingRegister: 3, InputRegister: 4 };
const EXCEPTION: Record<number, string> = {
  1: 'IllegalFunction',
  2: 'IllegalDataAddress',
  3: 'IllegalDataValue',
  4: 'ServerDeviceFailure',
  6: 'ServerDeviceBusy',
  10: 'GatewayPathUnavailable',
  11: 'GatewayTargetDeviceFailedToRespond',
};

interface Waiting {
  resolve: (pdu: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ModbusTcpClient {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    const fail = (error: Error): void => this.failAll(error);
    socket.on('error', fail);
    socket.on('close', () => this.failAll(new Error(tr('연결이 끊겼습니다.'))));
  }

  static connect(host: string, port: number, timeoutMs = 3000): Promise<ModbusTcpClient> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(fill(tr('Modbus 장치에 붙지 못했습니다(시간 초과): {0}:{1}'), { 0: host, 1: port })));
      }, timeoutMs);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new ModbusTcpClient(socket, timeoutMs));
      });
    });
  }

  /** Returns a list of words (registers) or bits (0/1) */
  async read(unitId: number, entity: ModbusEntity, address: number, quantity: number): Promise<number[]> {
    const fc = FUNCTION[entity];
    const pdu = await this.request(unitId, Buffer.from([fc, address >> 8, address & 0xff, quantity >> 8, quantity & 0xff]));
    if (pdu[0] === (fc | 0x80)) throw new Error(EXCEPTION[pdu[1] ?? 0] ?? `Exception ${String(pdu[1])}`);
    if (pdu[0] !== fc) throw new Error(fill(tr('기대하지 않은 응답 기능 번호: {0}'), { 0: String(pdu[0]) }));
    const data = pdu.subarray(2, 2 + (pdu[1] ?? 0));
    if (entity === 'Coil' || entity === 'DiscreteInput') {
      return Array.from({ length: quantity }, (_, index) => ((data[index >> 3] ?? 0) >> (index & 7)) & 1);
    }
    return Array.from({ length: Math.floor(data.length / 2) }, (_, index) => data.readUInt16BE(index * 2));
  }

  close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error(tr('닫았습니다.')));
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.end(() => resolve());
      this.socket.destroy();
    });
  }

  private request(unitId: number, pdu: Buffer): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error(tr('닫힌 연결입니다.')));
    const id = this.nextId;
    this.nextId = (this.nextId % 0xffff) + 1;
    const header = Buffer.alloc(7);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('Timeout'));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, pdu]));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 7) {
      const length = this.buffer.readUInt16BE(4);
      const total = 6 + length;
      if (this.buffer.length < total) return;
      const id = this.buffer.readUInt16BE(0);
      const pdu = this.buffer.subarray(7, total);
      this.buffer = this.buffer.subarray(total);
      const waiting = this.waiting.get(id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      this.waiting.delete(id);
      waiting.resolve(Buffer.from(pdu));
    }
  }

  private failAll(error: Error): void {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
      this.waiting.delete(id);
    }
  }
}
