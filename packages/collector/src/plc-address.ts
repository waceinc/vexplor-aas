/**
 * Siemens S7 and MELSEC MC protocol addresses — pure parsing, no sockets (2.10.0 draft).
 *
 * Important: **VEXPLOR extension bindings.** AID 1.1 (IDTA-02017) names OPC UA, Modbus, MQTT, HTTP and BACnet only;
 *    there is no S7 or MC binding and no W3C WoT binding to borrow terms from. So we invent no `s7v_*` / `mcv_*`
 *    form vocabulary: the whole address lives in the standard places the AID already has —
 *      EndpointMetadata.base = `s7://host[:102]?rack=0&slot=1` · `melsec://host:port?series=Q`
 *      forms.href            = the address the PLC engineering tool shows, plus the data type:
 *                              S7 `DB10.DBD4:REAL` · `M10.3` · `IW2:INT`, MC `D100` · `D200:REAL` · `X1F` · `D10.3`
 *    and the interface carries our binding IRI (`BINDING_IRI`) as a supplemental semanticId, so a reader that does not
 *    know it sees an unknown protocol instead of guessing. Builder (aid-build.ts), server reader and edge share this
 *    grammar — if they diverged, "created it but collection doesn't work" would follow.
 * Important: read only. Nothing here describes a write; this product never changes the PLC program or its values.
 */
import { fill, tr } from '@aas/core';

/** Our IRIs for the extension bindings — stated on the interface (supplementalSemanticIds). XGT: xgt-address.ts */
export const BINDING_IRI = { S7: 'urn:vexplor:aid:binding:s7', MC: 'urn:vexplor:aid:binding:mc', XGT: 'urn:vexplor:aid:binding:xgt' } as const;

/** The protocols whose grammar lives here and in xgt-address.ts */
export type PlcProtocolName = 'S7' | 'MC' | 'XGT';

/** IEC 61131-3 elementary type names as TIA Portal and GX Works show them */
export const PLC_TYPES = ['BOOL', 'BYTE', 'SINT', 'USINT', 'CHAR', 'WORD', 'INT', 'UINT', 'DWORD', 'DINT', 'UDINT', 'REAL', 'LREAL', 'LINT', 'ULINT', 'STRING'] as const;
export type PlcType = (typeof PLC_TYPES)[number];

/** Spellings people copy from other tools — mapped to the IEC name */
const ALIASES: Record<string, PlcType> = { INT16: 'INT', UINT16: 'UINT', INT32: 'DINT', UINT32: 'UDINT', FLOAT: 'REAL', DOUBLE: 'LREAL', INT64: 'LINT', UINT64: 'ULINT', LWORD: 'ULINT' };

export const WIDTH: Record<Exclude<PlcType, 'BOOL' | 'STRING'>, number> = {
  BYTE: 1, SINT: 1, USINT: 1, CHAR: 1, WORD: 2, INT: 2, UINT: 2, DWORD: 4, DINT: 4, UDINT: 4, REAL: 4, LREAL: 8, LINT: 8, ULINT: 8,
};

export interface PlcValueType {
  type: PlcType;
  /** STRING only — the declared character count */
  length?: number;
}

/** `REAL` · `string[20]` · `INT16` → the type, or undefined when it is not one we read */
export function plcTypeOf(text: string): PlcValueType | undefined {
  const upper = text.trim().toUpperCase();
  const string = /^STRING(?:\[(\d{1,3})\])?$/.exec(upper);
  if (string) {
    const length = string[1] === undefined ? 254 : Number(string[1]);
    return length >= 1 && length <= 254 ? { type: 'STRING', length } : undefined;
  }
  const type = ALIASES[upper] ?? (PLC_TYPES as readonly string[]).find((name) => name === upper);
  return type ? { type: type as PlcType } : undefined;
}

/** Bytes a value occupies (S7 STRING has the two header bytes: maximum and actual length) */
export function plcWidth(value: PlcValueType, protocol: PlcProtocolName): number {
  if (value.type === 'BOOL') return 1;
  if (value.type === 'STRING') return (value.length ?? 254) + (protocol === 'S7' ? 2 : 0);
  return WIDTH[value.type];
}

/** WoT type the AID `type` element should carry for a PLC type — what the screen preselects */
export function wotTypeOf(type: PlcType): 'boolean' | 'integer' | 'float' | 'string' {
  if (type === 'BOOL') return 'boolean';
  if (type === 'REAL' || type === 'LREAL') return 'float';
  if (type === 'STRING' || type === 'CHAR') return 'string';
  return 'integer';
}

/** `address:TYPE` → both parts (shared with xgt-address.ts) */
export function splitType(href: string): { address: string; value?: PlcValueType } {
  const [address = '', typeText, extra] = href.trim().split(':');
  if (extra !== undefined) throw new Error(fill(tr('PLC 주소가 이상합니다: {0}'), { 0: href }));
  if (typeText === undefined) return { address };
  const value = plcTypeOf(typeText);
  if (!value) throw new Error(fill(tr('PLC 자료형을 모릅니다: {0} — 쓸 수 있는 것: {1}'), { 0: typeText, 1: PLC_TYPES.join(' · ') }));
  return { address, value };
}

/** Host, port and query of `scheme://host[:port][/][?query]` — collector code has no URL global (pure logic) */
export interface Endpoint {
  host: string;
  port?: number;
  params: Map<string, string>;
}

export function endpointOf(base: string, scheme: string): Endpoint {
  const match = new RegExp(`^${scheme}://(\\[[^\\]]+\\]|[^/?#:@\\s]+)(?::(\\d{1,5}))?/?(?:\\?([^#]*))?$`, 'i').exec(base.trim());
  if (!match) throw new Error(fill(tr('접속 주소는 {0}://호스트[:포트] 꼴이어야 합니다: {1}'), { 0: scheme, 1: base }));
  const params = new Map<string, string>();
  for (const pair of (match[3] ?? '').split('&')) {
    if (pair === '') continue;
    const [key = '', value = ''] = pair.split('=');
    params.set(decodeURIComponent(key).toLowerCase(), decodeURIComponent(value));
  }
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error(fill(tr('접속 주소는 {0}://호스트[:포트] 꼴이어야 합니다: {1}'), { 0: scheme, 1: base }));
  return { host: match[1]!.replace(/^\[|\]$/g, ''), ...(port !== undefined ? { port } : {}), params };
}

export function intParam(endpoint: Endpoint, name: string, fallback: number, max: number): number {
  const text = endpoint.params.get(name);
  if (text === undefined) return fallback;
  const value = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(fill(tr('접속 주소의 {0} 값이 이상합니다: {1} — 0 ~ {2}'), { 0: name, 1: text, 2: max }));
  }
  return value;
}

// ── S7 ─────────────────────────────────────────────────────────────────────────────────────────────

export interface S7Endpoint {
  host: string;
  port: number;
  rack: number;
  slot: number;
}

/** `s7://host[:port]?rack=0&slot=1` — ISO-on-TCP port 102 by default; rack 0 slot 1 fits S7-1200/1500, S7-300 uses slot 2 */
export function s7Endpoint(base: string): S7Endpoint {
  const url = endpointOf(base, 's7');
  return { host: url.host, port: url.port ?? 102, rack: intParam(url, 'rack', 0, 7), slot: intParam(url, 'slot', 1, 31) };
}

export type S7Area = 'DB' | 'M' | 'I' | 'Q';

export interface S7Address extends PlcValueType {
  area: S7Area;
  /** Data block number — 0 outside DB */
  db: number;
  /** Byte offset */
  offset: number;
  /** Bit 0–7 for BOOL */
  bit?: number;
  /** Bytes to read */
  bytes: number;
}

/** The size letter's default type and the widths it allows (X bit · B byte · W word · D double word) */
const SIZE_DEFAULT: Record<string, PlcType> = { X: 'BOOL', B: 'BYTE', W: 'WORD', D: 'DWORD' };
/** 0 = bit, -1 = string, else bytes */
const sizeClass = (value: PlcValueType): number => (value.type === 'BOOL' ? 0 : value.type === 'STRING' ? -1 : WIDTH[value.type]);
const SIZE_FITS: Record<string, (size: number) => boolean> = {
  X: (size) => size === 0,
  // A byte address is also where a STRING or an 8-byte value starts (no size letter covers them)
  B: (size) => size === 1 || size === -1 || size === 8,
  W: (size) => size === 2,
  D: (size) => size === 4 || size === 8,
};
/** German mnemonics (E inputs, A outputs) are what STEP 7 shows with German settings */
const AREA_OF: Record<string, S7Area> = { M: 'M', I: 'I', E: 'I', Q: 'Q', A: 'Q' };
/** The read-var item carries the bit address in 3 bytes — the byte offset therefore stops at 2^21 - 1 */
const S7_MAX_OFFSET = 0x1fffff;

/** `DB10.DBD4:REAL` · `DB1.DBX0.3` · `M10.3` · `MW20:INT` · `IB0` · `QX1.0` · `DB2.DBB0:STRING[20]` */
export function s7Address(href: string): S7Address {
  const { address, value } = splitType(href);
  const bad = (): Error => new Error(fill(tr('S7 주소가 이상합니다: {0} — 예: DB10.DBD4:REAL · DB1.DBX0.3 · M10.3 · MW20:INT · IB0'), { 0: href }));
  const upper = address.toUpperCase();
  const db = /^DB(\d{1,5})\.DB([XBWD])(\d{1,7})(?:\.(\d))?$/.exec(upper);
  const other = db ? undefined : /^([MIEQA])([XBWD]?)(\d{1,7})(?:\.(\d))?$/.exec(upper);
  const match = db ?? other;
  if (!match) throw bad();
  const area: S7Area = db ? 'DB' : AREA_OF[match[1]!]!;
  const dbNumber = db ? Number(match[1]) : 0;
  const size = (match[2] || 'X') as 'X' | 'B' | 'W' | 'D';
  const offset = Number(match[3]);
  const bitText = match[4];
  if ((db && (dbNumber < 1 || dbNumber > 65535)) || offset > S7_MAX_OFFSET) throw bad();
  // A bit address needs its bit and only a bit address has one
  if ((size === 'X') !== (bitText !== undefined)) throw bad();
  const bit = bitText === undefined ? undefined : Number(bitText);
  if (bit !== undefined && bit > 7) throw bad();
  const type = value ?? { type: SIZE_DEFAULT[size]! };
  if (!SIZE_FITS[size]!(sizeClass(type))) {
    throw new Error(fill(tr('S7 주소 {0} 의 크기 글자와 자료형 {1} 이 맞지 않습니다 — X 는 BOOL, B 는 1바이트 · STRING · 8바이트, W 는 2바이트, D 는 4 · 8바이트'), { 0: address, 1: type.type }));
  }
  return { area, db: dbNumber, offset, ...(bit !== undefined ? { bit } : {}), ...type, bytes: plcWidth(type, 'S7') };
}

// ── MELSEC MC protocol (3E frame, binary) ──────────────────────────────────────────────────────────

export type McSeries = 'Q' | 'iQ-R' | 'iQ-F';
const SERIES: Record<string, McSeries> = { Q: 'Q', L: 'Q', 'IQ-R': 'iQ-R', IQR: 'iQ-R', 'IQ-F': 'iQ-F', IQF: 'iQ-F', FX5: 'iQ-F' };

export interface McEndpoint {
  host: string;
  port: number;
  series: McSeries;
  /** Network number and PC (station) number of the request destination — 0 and 0xFF reach the connected station */
  network: number;
  station: number;
}

/** `melsec://host:port?series=Q` — the port is the one set in the PLC's Ethernet settings; MC has no fixed port */
export function mcEndpoint(base: string): McEndpoint {
  const url = endpointOf(base, 'melsec');
  if (url.port === undefined) throw new Error(fill(tr('MC 프로토콜은 정해진 포트가 없습니다 — PLC 이더넷 설정의 포트를 주소에 적으십시오: {0}'), { 0: base }));
  const seriesText = url.params.get('series') ?? 'Q';
  const series = SERIES[seriesText.toUpperCase()];
  if (!series) throw new Error(fill(tr('접속 주소의 series 값이 이상합니다: {0} — 쓸 수 있는 것: Q · L · iQ-R · iQ-F'), { 0: seriesText }));
  return { host: url.host, port: url.port, series, network: intParam(url, 'network', 0, 255), station: intParam(url, 'station', 0xff, 255) };
}

export type McDevice = 'D' | 'M' | 'X' | 'Y' | 'W' | 'R';
/** Device codes of the 3E binary frame (Q/L-compatible device specification, which iQ-R and iQ-F also accept) */
export const MC_DEVICE_CODE: Record<McDevice, number> = { D: 0xa8, M: 0x90, X: 0x9c, Y: 0x9d, W: 0xb4, R: 0xaf };
const BIT_DEVICES = new Set<McDevice>(['M', 'X', 'Y']);

export interface McAddress extends PlcValueType {
  device: McDevice;
  /** Device number as sent in the frame */
  number: number;
  bitDevice: boolean;
  /** Bit 0–15 of a word device (`D10.3`) */
  bit?: number;
  /** Points to read — words for word devices, bits for bit devices */
  points: number;
}

/** Numbering as the engineering tool shows it — X · Y · W hexadecimal, but X · Y octal on iQ-F (FX5) */
function radixOf(device: McDevice, series: McSeries): 8 | 10 | 16 {
  if (device === 'X' || device === 'Y') return series === 'iQ-F' ? 8 : 16;
  return device === 'W' ? 16 : 10;
}

/** `D100` · `D200:REAL` · `D10.3` · `M50` · `X1F` · `W1A:DINT` · `R0:STRING[10]` */
export function mcAddress(href: string, series: McSeries = 'Q'): McAddress {
  const { address, value } = splitType(href);
  const bad = (): Error => new Error(fill(tr('MC 주소가 이상합니다: {0} — 예: D100 · D200:REAL · D10.3 · M50 · X1F · W1A:DINT'), { 0: href }));
  const match = /^([DMXYWR])([0-9A-F]{1,7})(?:\.([0-9A-F]))?$/.exec(address.toUpperCase());
  if (!match) throw bad();
  const device = match[1] as McDevice;
  const radix = radixOf(device, series);
  const digits = radix === 16 ? /^[0-9A-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^\d+$/;
  if (!digits.test(match[2]!)) throw bad();
  const number = parseInt(match[2]!, radix);
  // The device number field is 3 bytes
  if (number > 0xffffff) throw bad();
  const bitDevice = BIT_DEVICES.has(device);
  const bit = match[3] === undefined ? undefined : parseInt(match[3], 16);
  if (bitDevice && bit !== undefined) throw bad();
  const type = value ?? { type: bitDevice || bit !== undefined ? 'BOOL' : 'INT' };
  if (bitDevice || bit !== undefined) {
    if (type.type !== 'BOOL') throw new Error(fill(tr('MC 주소 {0} 는 비트입니다 — 자료형은 BOOL 만 됩니다'), { 0: address }));
    return { device, number, bitDevice, ...(bit !== undefined ? { bit } : {}), ...type, points: 1 };
  }
  if (type.type === 'BOOL' || WIDTH[type.type as keyof typeof WIDTH] === 1) {
    throw new Error(fill(tr('MC 워드 디바이스 {0} 에는 {1} 을 쓸 수 없습니다 — 비트는 D10.3 처럼 적습니다'), { 0: address, 1: type.type }));
  }
  return { device, number, bitDevice, ...type, points: Math.ceil(plcWidth(type, 'MC') / 2) };
}
