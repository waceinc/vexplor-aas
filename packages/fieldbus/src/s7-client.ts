/**
 * S7 client over ISO-on-TCP — only "Read Var" (S7comm function 0x04). Never writes (no 0x05 Write Var is built).
 *
 * Layers, as published:
 *   TPKT     RFC 1006 §6         version 3 · reserved · 16-bit length of the whole packet
 *   COTP     ISO 8073 / X.224    CR (0xE0) → CC (0xD0) with TSAP parameters; then DT (0xF0) with EOT carrying S7 data
 *   S7comm   the S7 "Job" (ROSCTR 1) / "Ack_Data" (ROSCTR 3) PDU — not an open standard; the layout used here is the one
 *            documented by the Wireshark S7comm dissector (epan/dissectors/packet-s7comm.c). Setup Communication (0xF0)
 *            negotiates the PDU size every later request and answer must fit.
 * Remote TSAP = connection type (1 = PG) · rack × 32 + slot — the convention of the vendor's engineering tools.
 */
import type { S7Area, S7Endpoint } from '@aas/collector';
import { fill, tr } from '@aas/core';
import { FrameSocket } from './plc-socket.js';

/** Area codes of a read-var item */
export const S7_AREA_CODE: Record<S7Area, number> = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 };
/** Item return codes (0xFF = success) — names as the dissector gives them, like Modbus exception names */
const ITEM_ERROR: Record<number, string> = {
  0x01: 'HardwareFault',
  0x03: 'AccessDenied',
  0x05: 'AddressOutOfRange',
  0x06: 'DataTypeNotSupported',
  0x07: 'DataTypeInconsistent',
  0x0a: 'ObjectDoesNotExist',
};
/** Upper bound of items in one request — what S7-300 CPUs accept and common clients use */
export const S7_MAX_ITEMS = 20;
/** Bytes around the items: request = 10 header + 2 parameter head (+12 per item); answer = 12 header + 2 (+4 per item) */
export const S7_REQUEST_OVERHEAD = 12;
export const S7_ANSWER_OVERHEAD = 14;

export interface S7Item {
  area: S7Area;
  db: number;
  /** Byte offset */
  start: number;
  /** Set for a single-bit read */
  bit?: number;
  /** Bytes to read (1 for a bit) */
  bytes: number;
}

export interface S7ItemResult {
  data?: Buffer;
  error?: string;
}

/** TPKT: bytes 2–3 are the length of the whole packet */
const tpktLength = (buffer: Buffer): number | undefined => (buffer.length >= 4 ? buffer.readUInt16BE(2) : undefined);

const tpkt = (payload: Buffer): Buffer => {
  const header = Buffer.from([0x03, 0x00, 0x00, 0x00]);
  header.writeUInt16BE(payload.length + 4, 2);
  return Buffer.concat([header, payload]);
};
/** The S7 PDU inside TPKT + COTP DT — byte 4 is the COTP header length (2 for DT) */
const s7Of = (packet: Buffer): Buffer => packet.subarray(5 + (packet[4] ?? 2));
/** COTP DT with EOT — every S7 PDU travels in one */
const COTP_DT = Buffer.from([0x02, 0xf0, 0x80]);

export class S7Client {
  private nextRef = 1;

  private constructor(
    private readonly socket: FrameSocket,
    /** Negotiated PDU size — no request or answer may be larger */
    readonly pduSize: number,
  ) {}

  static async connect(endpoint: S7Endpoint, timeoutMs = 3000): Promise<S7Client> {
    const socket = await FrameSocket.connect(endpoint.host, endpoint.port, tpktLength, timeoutMs, 'S7');
    try {
      // COTP CR: dst ref 0 · src ref 1 · class 0 · TPDU size 1024 (0x0A) · calling TSAP 0x0100 · called TSAP PG/rack/slot
      const cr = Buffer.from([0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, (endpoint.rack << 5) | endpoint.slot]);
      const cc = await socket.exchange(tpkt(cr));
      if (cc[5] !== 0xd0) {
        throw new Error(fill(tr('S7 장치가 연결을 받지 않았습니다 — rack {0} · slot {1} 이 맞는지 확인하십시오.'), { 0: endpoint.rack, 1: endpoint.slot }));
      }
      // Setup Communication: AmQ calling 1 · AmQ called 1 · PDU 480 (the CPU answers with what it accepts)
      const setup = Buffer.from([0x32, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]);
      const answer = await socket.exchange(tpkt(Buffer.concat([COTP_DT, setup])));
      const s7 = s7Of(answer);
      if (s7[0] !== 0x32 || s7[1] !== 0x03) throw new Error(tr('S7 장치의 응답 형식이 이상합니다.'));
      if (s7[10] !== 0 || s7[11] !== 0) throw headerError(s7[10]!, s7[11]!);
      const pdu = s7.length >= 20 ? s7.readUInt16BE(18) : 0;
      if (pdu < 64) throw new Error(tr('S7 장치의 응답 형식이 이상합니다.'));
      return new S7Client(socket, pdu);
    } catch (error) {
      await socket.close();
      throw error;
    }
  }

  get alive(): boolean {
    return this.socket.alive;
  }

  /**
   * One Read Var request. The caller keeps it within the PDU (S7_MAX_ITEMS, overheads above). Each item answers on
   * its own — one missing DB does not fail the others; a refused request fails all of them (thrown).
   */
  async read(items: readonly S7Item[]): Promise<S7ItemResult[]> {
    const params = Buffer.alloc(2 + items.length * 12);
    params[0] = 0x04;
    params[1] = items.length;
    items.forEach((item, index) => {
      const at = 2 + index * 12;
      const bitRead = item.bit !== undefined;
      // Variable specification 0x12 · length 0x0A · syntax ANY (0x10) · transport size BIT (1) or BYTE (2)
      params.set([0x12, 0x0a, 0x10, bitRead ? 0x01 : 0x02], at);
      params.writeUInt16BE(bitRead ? 1 : item.bytes, at + 4);
      params.writeUInt16BE(item.db, at + 6);
      params[at + 8] = S7_AREA_CODE[item.area];
      const address = item.start * 8 + (item.bit ?? 0);
      params.set([(address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff], at + 9);
    });
    const ref = this.nextRef;
    this.nextRef = (this.nextRef % 0xffff) + 1;
    const header = Buffer.from([0x32, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    header.writeUInt16BE(ref, 4);
    header.writeUInt16BE(params.length, 6);
    const answer = await this.socket.exchange(tpkt(Buffer.concat([COTP_DT, header, params])));
    const s7 = s7Of(answer);
    if (s7[0] !== 0x32 || s7[1] !== 0x03 || s7.length < 12) throw new Error(tr('S7 장치의 응답 형식이 이상합니다.'));
    // A refused request carries the error in the header and no parameters at all
    if (s7[10] !== 0 || s7[11] !== 0) throw headerError(s7[10]!, s7[11]!);
    if (s7.length < 14 || s7[12] !== 0x04 || s7[13] !== items.length) throw new Error(tr('S7 장치의 응답 형식이 이상합니다.'));
    const out: S7ItemResult[] = [];
    let at = 14;
    for (let index = 0; index < items.length; index += 1) {
      const code = s7[at];
      if (code === undefined) throw new Error(tr('S7 장치의 응답 형식이 이상합니다.'));
      if (code !== 0xff) {
        out.push({ error: `${ITEM_ERROR[code] ?? 'Error'} (0x${code.toString(16).padStart(2, '0')})` });
        // An item that failed carries a zero length and no data
        at += 4;
        continue;
      }
      const transport = s7[at + 1]!;
      const length = s7.readUInt16BE(at + 2);
      // BIT · BYTE/WORD/DWORD · INTEGER count bits; REAL and OCTET STRING count bytes
      const bytes = transport === 0x03 || transport === 0x04 || transport === 0x05 ? Math.ceil(length / 8) : length;
      out.push({ data: Buffer.from(s7.subarray(at + 4, at + 4 + bytes)) });
      at += 4 + bytes + (bytes % 2 === 1 && index < items.length - 1 ? 1 : 0);
    }
    return out;
  }

  close(): Promise<void> {
    return this.socket.close();
  }
}

/**
 * The CPU refused the whole request. 0x81 0x04 is what S7-1200/1500 answer when PUT/GET access is off — the commonest
 * cause in the field, so the message says how to turn it on.
 */
function headerError(errorClass: number, errorCode: number): Error {
  const code = `0x${errorClass.toString(16).padStart(2, '0')}${errorCode.toString(16).padStart(2, '0')}`;
  return new Error(fill(tr('S7 장치가 요청을 거절했습니다(오류 {0}) — S7-1200 · 1500 은 CPU 설정에서 「PUT/GET 통신 허용」을 켜고, 읽을 DB 의 「최적화된 블록 액세스」를 꺼야 읽힙니다.'), { 0: code }));
}
