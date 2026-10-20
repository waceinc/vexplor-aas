/**
 * LS ELECTRIC XGT dedicated protocol client (FEnet, TCP) — only the read request (instruction 0x0054). Never writes
 * (no write instruction frame is built anywhere — test/xgt.test.ts checks this file for one).
 *
 * Frame layout from LS ELECTRIC "XGT FEnet I/F Module User's Manual" V2.30, chapter 8, and "XGB FEnet I/F Module"
 * V1.5 §5.2 (frame examples Table 5-6 – 5-9). All multi-byte fields are little-endian ("h0054 ⇒ 5400", p.8-7).
 *   header (20)  "LSIS-XGT" 00 00 · PLC info (2) · CPU info (1) · source 0x33 (answer 0x11) · invoke id (2)
 *                · length of the instruction part (2) · FEnet position (1) · BCC = byte sum of the 19 bytes before it
 *   read         0x0054 · data type (X 00 · B 01 · W 02 · D 03 · L 04, continuous 0x14) · reserved 0000
 *                · blocks (1–16) · per block: name length (2) + name ("%DW100", ≤ 16 ASCII)
 *                · continuous only: byte count (2, ≤ 1,400) after its single name
 *   answer       0x0055 · data type · reserved · error status (0 = good) · then either the error code or the block
 *                count followed by per block: data size (2) + data
 * The BCC formula is checked against the manual's own examples (Table 5-8 0x3F, Table 5-7 0x2F, Table 5-9 0x26).
 * The invoke id comes back in the answer, so an answer that does not match the request is refused and the connection
 * dropped — a late answer must never be taken as the value of the next request.
 */
import { XGT_CPU_INFO, XGT_TYPE_CODE, type XgtEndpoint } from '@aas/collector';
import { fill, tr } from '@aas/core';
import { FrameSocket } from './plc-socket.js';

/** Error codes of the answer (XGT FEnet V2.30 §10.4 p.10-12) — the rest are shown in hex */
const ERROR_CODE: Record<number, string> = {
  0x0001: 'TooManyBlocks',
  0x0002: 'DataTypeNotSupported',
  0x0003: 'DeviceNotSupported',
  0x0004: 'AddressOutOfRange',
  0x0005: 'TooMuchData',
  0x0006: 'TooMuchData',
  0x0075: 'HeaderInvalid',
  0x0076: 'HeaderLengthInvalid',
  0x0077: 'HeaderChecksumInvalid',
  0x0078: 'InstructionInvalid',
};

const COMPANY_ID = Buffer.from('LSIS-XGT\0\0', 'latin1');
const HEADER = 20;

/** Answer length: the 20-byte header + the instruction length it states */
const frameLength = (buffer: Buffer): number | undefined => (buffer.length >= HEADER ? HEADER + buffer.readUInt16LE(16) : undefined);

export class XgtClient {
  private invoke = 0;

  private constructor(
    private readonly socket: FrameSocket,
    private readonly cpuInfo: number,
  ) {}

  static async connect(endpoint: XgtEndpoint, timeoutMs = 3000): Promise<XgtClient> {
    const socket = await FrameSocket.connect(endpoint.host, endpoint.port, frameLength, timeoutMs, 'XGT');
    return new XgtClient(socket, XGT_CPU_INFO[endpoint.series]);
  }

  get alive(): boolean {
    return this.socket.alive;
  }

  /** Continuous read of `count` bytes from a byte variable (`%DB200`) — the raw bytes */
  async readBytes(device: string, start: number, count: number): Promise<Buffer> {
    const name = Buffer.from(`%${device}B${start}`, 'latin1');
    const body = Buffer.alloc(12 + name.length);
    body.writeUInt16LE(0x0054, 0);
    body.writeUInt16LE(0x0014, 2);
    body.writeUInt16LE(0x0000, 4);
    body.writeUInt16LE(1, 6);
    body.writeUInt16LE(name.length, 8);
    name.copy(body, 10);
    body.writeUInt16LE(count, 10 + name.length);
    const [data] = await this.exchange(body, 0x0014);
    if (!data || data.length < count) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    return data.subarray(0, count);
  }

  /** Individual read of up to 16 variables of one size letter — each block's data, in request order */
  async readVariables(size: keyof typeof XGT_TYPE_CODE, names: readonly string[]): Promise<Buffer[]> {
    const encoded = names.map((name) => Buffer.from(name, 'latin1'));
    const body = Buffer.alloc(8 + encoded.reduce((sum, name) => sum + 2 + name.length, 0));
    body.writeUInt16LE(0x0054, 0);
    body.writeUInt16LE(XGT_TYPE_CODE[size], 2);
    body.writeUInt16LE(0x0000, 4);
    body.writeUInt16LE(encoded.length, 6);
    let at = 8;
    for (const name of encoded) {
      body.writeUInt16LE(name.length, at);
      name.copy(body, at + 2);
      at += 2 + name.length;
    }
    const blocks = await this.exchange(body, XGT_TYPE_CODE[size]);
    if (blocks.length !== names.length) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    return blocks;
  }

  close(): Promise<void> {
    return this.socket.close();
  }

  private async exchange(body: Buffer, dataType: number): Promise<Buffer[]> {
    this.invoke = (this.invoke + 1) & 0xffff;
    const frame = Buffer.alloc(HEADER + body.length);
    COMPANY_ID.copy(frame, 0);
    frame.writeUInt16LE(0x0000, 10);
    frame[12] = this.cpuInfo;
    frame[13] = 0x33;
    frame.writeUInt16LE(this.invoke, 14);
    frame.writeUInt16LE(body.length, 16);
    frame[18] = 0x00;
    frame[19] = headerSum(frame);
    body.copy(frame, HEADER);
    const answer = await this.socket.exchange(frame);
    // Important: the BCC of the answer is not checked — TCP already guards the bytes, and the manual does not say the
    //    module fills it on every answer; refusing on it could turn every reading into an error on a real module.
    if (answer.length < HEADER + 9 || !answer.subarray(0, 8).equals(COMPANY_ID.subarray(0, 8)) || answer[13] !== 0x11) {
      throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    }
    if (answer.readUInt16LE(14) !== this.invoke) {
      await this.socket.close();
      throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    }
    const at = HEADER;
    if (answer.readUInt16LE(at) !== 0x0055 || answer.readUInt16LE(at + 2) !== dataType) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    if (answer.readUInt16LE(at + 6) !== 0) {
      // Chapter 8 calls the code the lower byte of a 2-byte field; §10.4 shows a 2-byte code — both read the same here
      const code = answer.length >= at + 10 ? answer.readUInt16LE(at + 8) : (answer[at + 8] ?? 0);
      throw new Error(fill(tr('{0} (오류 코드 0x{1})'), { 0: ERROR_CODE[code] ?? 'Error', 1: code.toString(16).toUpperCase().padStart(4, '0') }));
    }
    if (answer.length < at + 10) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
    const count = answer.readUInt16LE(at + 8);
    const blocks: Buffer[] = [];
    let cursor = at + 10;
    for (let i = 0; i < count; i += 1) {
      if (cursor + 2 > answer.length) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
      const size = answer.readUInt16LE(cursor);
      if (cursor + 2 + size > answer.length) throw new Error(tr('XGT 장치의 응답 형식이 이상합니다.'));
      blocks.push(answer.subarray(cursor + 2, cursor + 2 + size));
      cursor += 2 + size;
    }
    return blocks;
  }
}

/** BCC of the application header — the byte sum of bytes 0 to 18 */
export function headerSum(frame: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 19; i += 1) sum += frame[i]!;
  return sum & 0xff;
}
