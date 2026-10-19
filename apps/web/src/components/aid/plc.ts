/**
 * Create collection link — S7 and MC rows (VEXPLOR extension bindings, not AID 1.1).
 *
 * The address and the data type are one href (`DB10.DBD4:REAL`, `D200:REAL`) — what the server's grammar
 * (@aas/collector plc-address.ts) reads. The screen keeps them apart (address box + type select) and joins them on
 * "Create". The checks here only mark a row before sending; the server stays the judge.
 * Important: this mirrors the server grammar — test/aid-plc.test.ts runs both over the same list so they cannot drift.
 */
export type PlcProtocol = 'S7' | 'MC';

/** Types offered in the select — '' keeps the address's own default (S7 size letter, MC INT or BOOL) */
export const PLC_TYPE_CHOICES: Record<PlcProtocol, readonly string[]> = {
  S7: ['', 'BOOL', 'BYTE', 'CHAR', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD', 'REAL', 'LREAL', 'LINT', 'STRING'],
  MC: ['', 'BOOL', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD', 'REAL', 'LREAL', 'LINT', 'STRING'],
};

const BYTES: Record<string, number> = { BYTE: 1, SINT: 1, USINT: 1, CHAR: 1, WORD: 2, INT: 2, UINT: 2, DWORD: 4, DINT: 4, UDINT: 4, REAL: 4, LREAL: 8, LINT: 8, ULINT: 8 };
const ALIASES: Record<string, string> = { INT16: 'INT', UINT16: 'UINT', INT32: 'DINT', UINT32: 'UDINT', FLOAT: 'REAL', DOUBLE: 'LREAL', INT64: 'LINT', UINT64: 'ULINT' };

/** The type part as the server reads it, or undefined when it is not one */
function typeOf(text: string): string | undefined {
  const upper = text.trim().toUpperCase();
  const string = /^STRING(?:\[(\d{1,3})\])?$/.exec(upper);
  if (string) return string[1] === undefined || (Number(string[1]) >= 1 && Number(string[1]) <= 254) ? 'STRING' : undefined;
  const name = ALIASES[upper] ?? upper;
  return name === 'BOOL' || BYTES[name] !== undefined ? name : undefined;
}

/** `?series=iQ-F` numbers X and Y in octal */
const iqf = (endpoint: string): boolean => /[?&]series=(iq-?f|fx5)(&|$)/i.test(endpoint);

/** Would the server accept this href on this endpoint? */
export function plcHrefOk(protocol: PlcProtocol, endpoint: string, href: string): boolean {
  const [address = '', typeText, extra] = href.trim().split(':');
  if (extra !== undefined) return false;
  const type = typeText === undefined ? undefined : typeOf(typeText);
  if (typeText !== undefined && type === undefined) return false;
  if (protocol === 'S7') {
    const match = /^(?:DB(\d{1,5})\.DB([XBWD])|([MIEQA])([XBWD]?))(\d{1,7})(?:\.(\d))?$/i.exec(address);
    if (!match) return false;
    if (match[1] !== undefined && (Number(match[1]) < 1 || Number(match[1]) > 65535)) return false;
    if (Number(match[5]) > 0x1fffff || (match[6] !== undefined && Number(match[6]) > 7)) return false;
    const size = (match[2] ?? (match[4] || 'X')).toUpperCase();
    if ((size === 'X') !== (match[6] !== undefined)) return false;
    if (type === undefined) return true;
    const width = type === 'BOOL' ? 0 : type === 'STRING' ? -1 : BYTES[type]!;
    return size === 'X' ? width === 0 : size === 'B' ? width === 1 || width === -1 || width === 8 : size === 'W' ? width === 2 : width === 4 || width === 8;
  }
  const match = /^([DMXYWR])([0-9A-F]{1,7})(?:\.([0-9A-F]))?$/i.exec(address);
  if (!match) return false;
  const device = match[1]!.toUpperCase();
  const digits = device === 'X' || device === 'Y' ? (iqf(endpoint) ? /^[0-7]+$/ : /^[0-9A-F]+$/i) : device === 'W' ? /^[0-9A-F]+$/i : /^\d+$/;
  if (!digits.test(match[2]!)) return false;
  const bitDevice = device === 'M' || device === 'X' || device === 'Y';
  if (bitDevice && match[3] !== undefined) return false;
  if (bitDevice || match[3] !== undefined) return type === undefined || type === 'BOOL';
  return type === undefined || (type !== 'BOOL' && BYTES[type] !== 1);
}

/** The href sent on "Create" — an address that already names its type (`:STRING[20]`) is sent as typed */
export function plcHrefOf(address: string, plcType: string | undefined): string {
  const text = address.trim();
  return text.includes(':') || !plcType ? text : `${text}:${plcType}`;
}

/** Splits a stored href back into address box and select — a type the select does not offer stays in the address */
export function splitPlcHref(protocol: PlcProtocol, href: string): { address: string; plcType: string } {
  const at = href.indexOf(':');
  if (at < 0) return { address: href, plcType: '' };
  const typeText = href.slice(at + 1).toUpperCase();
  return PLC_TYPE_CHOICES[protocol].includes(typeText) && typeText !== '' ? { address: href.slice(0, at), plcType: typeText } : { address: href, plcType: '' };
}

/** WoT type for the AID `type` element — from the chosen type, else from the address's default */
export function plcWotType(protocol: PlcProtocol, href: string): string {
  const [address = '', typeText] = href.trim().split(':');
  const type = typeText === undefined ? undefined : typeOf(typeText);
  const isBit = protocol === 'S7' ? /^(DB\d+\.DBX|[MIEQA]X?\d)/i.test(address) : /^[MXY]|\.[0-9A-F]$/i.test(address);
  const effective = type ?? (isBit ? 'BOOL' : 'INT');
  if (effective === 'BOOL') return 'boolean';
  if (effective === 'REAL' || effective === 'LREAL') return 'float';
  if (effective === 'STRING' || effective === 'CHAR') return 'string';
  return 'integer';
}
