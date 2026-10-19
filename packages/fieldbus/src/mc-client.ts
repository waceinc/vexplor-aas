/**
 * MELSEC MC protocol client — 3E frame, binary code, only Batch Read (command 0x0401). Never writes (no 0x1401).
 *
 * Frame layout from the vendor's published reference, "MELSEC Communication Protocol Reference Manual" (SH-080008),
 * chapter "Message formats" (3E frame) and "Batch read" (device access commands); the SLMP reference (SH-080956ENG)
 * describes the same 3E binary frame for iQ-R and iQ-F. All multi-byte fields are little-endian.
 *   request  50 00 · network · PC · 03FF (module I/O) · 00 (station) · data length · monitoring timer (×250 ms)
 *            · command 0401 · subcommand 0000 (word units) / 0001 (bit units) · device number (3 bytes) · code · points
 *   answer   D0 00 · network · PC · 03FF · 00 · data length · end code · data (or 9 bytes of error information)
 * There is no request id in a 3E frame — FrameSocket keeps one request in flight and drops the connection on timeout.
 */
import type { McEndpoint } from '@aas/collector';
import { fill, tr } from '@aas/core';
import { FrameSocket } from './plc-socket.js';

/** Most points one Batch Read may ask for (3E frame) — words in word units, bits in bit units */
export const MC_MAX_WORDS = 960;
export const MC_MAX_BITS = 7168;

/** End codes worth a name — the full list is in the CPU manual; the rest are shown in hex */
const END_CODE: Record<number, string> = {
  0xc050: 'AsciiDataNotConvertible',
  0xc051: 'TooManyPoints',
  0xc052: 'TooManyPoints',
  0xc054: 'TooManyPoints',
  0xc056: 'AddressOutOfRange',
  0xc058: 'RequestLengthMismatch',
  0xc059: 'CommandNotSupported',
  0xc05b: 'DeviceNotAccessible',
  0xc05c: 'RequestContentError',
  0xc061: 'RequestLengthMismatch',
};

/** Answer length: 9 header bytes (to and including the data length field) + the data length */
const frameLength = (buffer: Buffer): number | undefined => (buffer.length >= 9 ? 9 + buffer.readUInt16LE(7) : undefined);

export class McClient {
  private constructor(
    private readonly socket: FrameSocket,
    private readonly endpoint: McEndpoint,
    private readonly timer: number,
  ) {}

  static async connect(endpoint: McEndpoint, timeoutMs = 3000): Promise<McClient> {
    const socket = await FrameSocket.connect(endpoint.host, endpoint.port, frameLength, timeoutMs, 'MC');
    // The PLC gives up after the monitoring timer and answers with an error — set it a little under our own timeout
    const timer = Math.max(1, Math.min(0xffff, Math.floor((timeoutMs * 0.8) / 250)));
    return new McClient(socket, endpoint, timer);
  }

  get alive(): boolean {
    return this.socket.alive;
  }

  /** Word devices (D · W · R) or bit devices read 16 per word — returns the raw bytes, 2 per point */
  async readWords(code: number, number: number, points: number): Promise<Buffer> {
    const data = await this.batchRead(0x0000, code, number, points);
    if (data.length < points * 2) throw new Error(tr('MC 장치의 응답 형식이 이상합니다.'));
    return data.subarray(0, points * 2);
  }

  /** Bit devices (M · X · Y) in bit units — two points per byte, the first point in the high nibble */
  async readBits(code: number, number: number, points: number): Promise<boolean[]> {
    const data = await this.batchRead(0x0001, code, number, points);
    if (data.length < Math.ceil(points / 2)) throw new Error(tr('MC 장치의 응답 형식이 이상합니다.'));
    return Array.from({ length: points }, (_, index) => ((data[index >> 1]! >> (index % 2 === 0 ? 4 : 0)) & 0x0f) !== 0);
  }

  close(): Promise<void> {
    return this.socket.close();
  }

  private async batchRead(subcommand: number, code: number, number: number, points: number): Promise<Buffer> {
    const frame = Buffer.alloc(21);
    frame.writeUInt16LE(0x0050, 0);
    frame[2] = this.endpoint.network;
    frame[3] = this.endpoint.station;
    frame.writeUInt16LE(0x03ff, 4);
    frame[6] = 0x00;
    frame.writeUInt16LE(12, 7);
    frame.writeUInt16LE(this.timer, 9);
    frame.writeUInt16LE(0x0401, 11);
    frame.writeUInt16LE(subcommand, 13);
    frame.writeUIntLE(number, 15, 3);
    frame[18] = code;
    frame.writeUInt16LE(points, 19);
    const answer = await this.socket.exchange(frame);
    if (answer.readUInt16LE(0) !== 0x00d0 || answer.length < 11) throw new Error(tr('MC 장치의 응답 형식이 이상합니다.'));
    const end = answer.readUInt16LE(9);
    if (end !== 0) throw new Error(fill(tr('{0} (종료 코드 0x{1})'), { 0: END_CODE[end] ?? 'Error', 1: end.toString(16).toUpperCase().padStart(4, '0') }));
    return answer.subarray(11);
  }
}
