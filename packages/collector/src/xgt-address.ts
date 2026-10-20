/**
 * LS ELECTRIC XGT dedicated protocol addresses (FEnet, TCP 2004) — pure parsing, no sockets.
 *
 * Important: **VEXPLOR extension binding**, like S7 and MC (plc-address.ts): AID 1.1 has no XGT binding, so the whole
 *    address lives in the standard places —
 *      EndpointMetadata.base = `xgt://host[:2004]?series=XGK` (XGK · XGI · XGR · XGB · XEC)
 *      forms.href            = the address XG5000 shows, plus the data type:
 *                              XGK / XGB `D100` · `D200:REAL` · `D100.3` · `P0001A` · `M0010:BOOL` · `T10:BOOL`
 *                              XGI / XGR / XEC `%MW100` · `%MD10:REAL` · `%MX1603` · `%IX0.0.3` · `%QW0.1.2`
 *    and the interface carries `BINDING_IRI.XGT` as a supplemental semanticId.
 * Important: read only. Only "read" requests are ever described here.
 *
 * Sources — LS ELECTRIC "XGT FEnet I/F Module User's Manual" V2.30 (2018-05):
 *   §8.1.1 p.8-1     TCP port 2004 (UDP 2005) for the XGT dedicated driver
 *   §8.1.4 p.8-5     direct variables `%` + device + size letter (X B W D L) + number; data type codes
 *   §8.2.1 p.8-6     individual read: at most 16 blocks, a variable name at most 16 characters
 *   §8.2.2 p.8-9     continuous read: byte variables only (`%MB0` · `%DB0`), one block, at most 1,400 bytes
 *   §8.2.3 p.8-12    a bit number is word × 16 + bit — `%MX2764` is bit C of M172 (not `%MX172C`)
 *   Appendix A-1     XGK devices P M K F T C U Z L N D R ZR; A-2 XGI / XGR devices %I %Q %M %R %W %F %K %L %N %U %A
 * and "XGB FEnet I/F Module" V1.5 §5.2.3–5.2.4 p.5-3–5-4: CPU info XGB(MK) 0xB0, XGB(IEC) 0xB4; byte address = word
 * address × 2 (`D1234` = `%DW1234` = `%DB2468`). The XGB manual's L flag table (A.4, p.A-8) shows the XG5000 bit form:
 * `L5120` (word 512, bit 0) = `%LX8192`, `L514` as a double word = `%LD257`.
 * Not covered on purpose: U (base.slot.channel notation), Z (index registers), ZR, S (step), XGI %A (symbolic area)
 * and timer / counter structures of XGI — none of them is named in the manual's list of serviced devices.
 */
import { fill, tr } from '@aas/core';
import { WIDTH, endpointOf, plcWidth, splitType, type PlcType, type PlcValueType } from './plc-address.js';

export type XgtSeries = 'XGK' | 'XGI' | 'XGR' | 'XGB' | 'XEC';
const SERIES: Record<string, XgtSeries> = { XGK: 'XGK', XGI: 'XGI', XGR: 'XGR', XGB: 'XGB', 'XGB-MK': 'XGB', XEC: 'XEC', 'XGB-IEC': 'XEC' };

/** CPU info byte of the application header, per series (XGT FEnet §8.1.2 p.8-2, XGB FEnet §5.2.3 p.5-3) */
export const XGT_CPU_INFO: Record<XgtSeries, number> = { XGK: 0xa0, XGI: 0xa4, XGR: 0xa8, XGB: 0xb0, XEC: 0xb4 };
/** Most bytes one continuous read returns, most blocks one individual read carries, longest variable name */
export const XGT_MAX_BYTES = 1400;
export const XGT_MAX_BLOCKS = 16;
export const XGT_MAX_NAME = 16;

export interface XgtEndpoint {
  host: string;
  port: number;
  series: XgtSeries;
}

/** `xgt://host[:2004]?series=XGK` — XGK when the series is not stated */
export function xgtEndpoint(base: string): XgtEndpoint {
  const url = endpointOf(base, 'xgt');
  const seriesText = url.params.get('series') ?? 'XGK';
  const series = SERIES[seriesText.toUpperCase()];
  if (!series) throw new Error(fill(tr('접속 주소의 series 값이 이상합니다: {0} — 쓸 수 있는 것: XGK · XGI · XGR · XGB · XEC'), { 0: seriesText }));
  return { host: url.host, port: url.port ?? 2004, series };
}

/** XGK-style devices (XGK and XGB "MK") and IEC-style flat devices (XGI · XGR · XEC); I and Q are base.slot.number */
const XGK_DEVICES = new Set(['P', 'M', 'K', 'F', 'T', 'C', 'L', 'N', 'D', 'R']);
const IEC_DEVICES = new Set(['M', 'R', 'W', 'F', 'K', 'L', 'N']);
/** Devices whose words are made of bits in XG5000's notation (`P0001A`); T and C bits are contacts, numbered alone */
const BIT_WORD_DEVICES = new Set(['P', 'M', 'K', 'F', 'L']);
type Size = 'X' | 'B' | 'W' | 'D' | 'L';
const SIZE_BYTES: Record<Size, number> = { X: 1, B: 1, W: 2, D: 4, L: 8 };
/** Data type code of the request (§8.1.4 Table 8.1.3) */
export const XGT_TYPE_CODE: Record<Size, number> = { X: 0x00, B: 0x01, W: 0x02, D: 0x03, L: 0x04 };
const SIZE_DEFAULT: Record<Size, PlcType> = { X: 'BOOL', B: 'BYTE', W: 'WORD', D: 'DWORD', L: 'ULINT' };

/**
 * One XGT address. `block` addresses are read as part of a continuous byte read (`%DB200`, merged with neighbours);
 * `single` ones by name in an individual read — I / Q (base.slot.number has no flat byte address) and T / C contacts.
 */
export type XgtAddress = PlcValueType & { device: string; bytes: number } & (
    | { mode: 'block'; byte: number; bit?: number }
    | { mode: 'single'; name: string; size: Size }
  );

const isXgkStyle = (series: XgtSeries): boolean => series === 'XGK' || series === 'XGB';

/** A type that may start at a size letter of a flat device: X only BOOL; B anything; W · D · L at least their width */
function fitsBlock(size: Size, value: PlcValueType): boolean {
  if (value.type === 'BOOL') return size === 'X';
  if (size === 'X') return false;
  if (value.type === 'STRING') return size === 'B' || size === 'W';
  return WIDTH[value.type as keyof typeof WIDTH] >= SIZE_BYTES[size];
}

/** I / Q and contacts are read as exactly one variable — the type must have the size letter's width */
function fitsSingle(size: Size, value: PlcValueType): boolean {
  if (value.type === 'BOOL') return size === 'X';
  if (size === 'X' || value.type === 'STRING') return false;
  return WIDTH[value.type as keyof typeof WIDTH] === SIZE_BYTES[size];
}

export function xgtAddress(href: string, series: XgtSeries = 'XGK'): XgtAddress {
  const { address, value } = splitType(href);
  const upper = address.toUpperCase();
  const examples = isXgkStyle(series) ? 'D100 · D200:REAL · D100.3 · P0001A · M0010:BOOL · %MW100' : '%MW100 · %MD10:REAL · %MX1603 · %IX0.0.3';
  const bad = (): Error => new Error(fill(tr('XGT 주소가 이상합니다: {0} — 예: {1}'), { 0: href, 1: examples }));
  const misfit = (type: string): Error => new Error(fill(tr('XGT 주소 {0} 에는 자료형 {1} 을 쓸 수 없습니다'), { 0: address, 1: type }));
  const notHere = (device: string): Error =>
    new Error(fill(tr('{0} 계열에서 읽는 디바이스가 아닙니다: {1} — 계열은 접속 주소에 ?series=XGK · XGI · XGR · XGB · XEC 로 적습니다'), { 0: series, 1: device }));

  // I / Q of the IEC series: %IX0.0.3 — base . slot . number, read by name
  const io = /^%([IQ])([XBWDL])(\d{1,3})\.(\d{1,2})\.(\d{1,3})$/.exec(upper);
  if (io) {
    if (isXgkStyle(series)) throw notHere(io[1]!);
    const size = io[2] as Size;
    const type = value ?? { type: SIZE_DEFAULT[size] };
    if (!fitsSingle(size, type)) throw misfit(type.type);
    return { device: io[1]!, mode: 'single', name: upper, size, ...type, bytes: SIZE_BYTES[size] };
  }

  // Direct variable as the protocol names it: %MW100 · %DB200 · %PX26 · %TX10
  const direct = /^%([A-Z])([XBWDL])(\d{1,7})$/.exec(upper);
  if (direct) {
    const device = direct[1]!;
    if (!(isXgkStyle(series) ? XGK_DEVICES : IEC_DEVICES).has(device)) throw notHere(device);
    const size = direct[2] as Size;
    const number = Number(direct[3]);
    const type = value ?? { type: SIZE_DEFAULT[size] };
    // T / C bits are contacts — a separate area from the current values the bytes and words hold (XGB FEnet §5.2.4 Note 1)
    if ((device === 'T' || device === 'C') && size === 'X') {
      if (type.type !== 'BOOL') throw misfit(type.type);
      return { device, mode: 'single', name: upper, size, ...type, bytes: 1 };
    }
    if (!fitsBlock(size, type)) throw misfit(type.type);
    if (size === 'X') return { device, mode: 'block', byte: Math.floor(number / 8), bit: number % 8, ...type, bytes: 1 };
    return { device, mode: 'block', byte: number * SIZE_BYTES[size], ...type, bytes: plcWidth(type, 'XGT') };
  }
  if (!isXgkStyle(series)) throw bad();

  // XG5000 notation of XGK / XGB: D100 (word) · D100.3 (bit of a word) · P0001A (word 1, bit A) · T10:BOOL (contact)
  const word = /^([A-Z])(\d{1,6})(?:\.([0-9A-F])|([A-F]))?$/.exec(upper);
  if (!word) throw bad();
  const device = word[1]!;
  if (!XGK_DEVICES.has(device)) throw notHere(device);
  const digits = word[2]!;
  const bitText = word[3] ?? word[4];
  const type = value ?? { type: bitText !== undefined ? 'BOOL' : 'INT' };
  if (type.type === 'BOOL') {
    if (device === 'T' || device === 'C') {
      if (bitText !== undefined) throw bad();
      return { device, mode: 'single', name: `%${device}X${Number(digits)}`, size: 'X', ...type, bytes: 1 };
    }
    // `M0010:BOOL` — the last digit is the bit, as XG5000 writes it; only bit devices have that form
    if (bitText === undefined && !BIT_WORD_DEVICES.has(device)) throw new Error(fill(tr('{0} 의 비트는 {0}100.3 처럼 점을 찍어 적습니다: {1}'), { 0: device, 1: address }));
    const wordNumber = bitText !== undefined ? Number(digits) : Number(digits.slice(0, -1) || '0');
    const bit = parseInt(bitText ?? digits.slice(-1), 16);
    return { device, mode: 'block', byte: wordNumber * 2 + (bit >> 3), bit: bit & 7, ...type, bytes: 1 };
  }
  if (bitText !== undefined) throw misfit(type.type);
  if (type.type !== 'STRING' && WIDTH[type.type as keyof typeof WIDTH] === 1) throw misfit(type.type);
  return { device, mode: 'block', byte: Number(digits) * 2, ...type, bytes: plcWidth(type, 'XGT') };
}

