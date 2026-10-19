/**
 * Create collection link — the XGT row check (LS ELECTRIC XGT dedicated protocol, VEXPLOR extension binding).
 * Important: this mirrors @aas/collector xgt-address.ts — test/aid-plc.test.tsx runs both over one list of samples so
 *    the screen cannot mark an address the server takes, or let through one it refuses. The server stays the judge.
 */
const SERIES: Record<string, string> = { XGK: 'XGK', XGI: 'XGI', XGR: 'XGR', XGB: 'XGB', 'XGB-MK': 'XGB', XEC: 'XEC', 'XGB-IEC': 'XEC' };
const XGK_DEVICES = 'PMKFTCLNDR';
const IEC_DEVICES = 'MRWFKLN';
const BIT_WORD_DEVICES = 'PMKFL';
const SIZE_BYTES: Record<string, number> = { X: 1, B: 1, W: 2, D: 4, L: 8 };

/** The series the endpoint states (XGK when none), or undefined when the server would refuse it */
export function xgtSeries(endpoint: string): string | undefined {
  const match = /[?&]series=([^&#]*)/i.exec(endpoint);
  return SERIES[(match ? decodeURIComponent(match[1]!) : 'XGK').toUpperCase()];
}

const xgkStyle = (series: string): boolean => series === 'XGK' || series === 'XGB';

/**
 * `width` is the type's byte width (0 = BOOL, -1 = STRING), undefined when no type is given.
 * Returns whether the server grammar would accept the address on this series.
 */
export function xgtAddressOk(endpoint: string, address: string, width: number | undefined): boolean {
  const series = xgtSeries(endpoint);
  if (!series) return false;
  const upper = address.trim().toUpperCase();
  const io = /^%([IQ])([XBWDL])\d{1,3}\.\d{1,2}\.\d{1,3}$/.exec(upper);
  if (io) {
    if (xgkStyle(series)) return false;
    const size = io[2]!;
    return width === undefined || (size === 'X' ? width === 0 : width > 0 && width === SIZE_BYTES[size]);
  }
  const direct = /^%([A-Z])([XBWDL])\d{1,7}$/.exec(upper);
  if (direct) {
    if (!(xgkStyle(series) ? XGK_DEVICES : IEC_DEVICES).includes(direct[1]!)) return false;
    const size = direct[2]!;
    if (width === undefined) return true;
    if (width === 0 || size === 'X') return width === 0 && size === 'X';
    if (width === -1) return size === 'B' || size === 'W';
    return width >= SIZE_BYTES[size]!;
  }
  if (!xgkStyle(series)) return false;
  const word = /^([A-Z])(\d{1,6})(?:\.([0-9A-F])|([A-F]))?$/.exec(upper);
  if (!word || !XGK_DEVICES.includes(word[1]!)) return false;
  const device = word[1]!;
  const bit = word[3] ?? word[4];
  const bool = width === 0 || (width === undefined && bit !== undefined);
  if (bool) {
    if (device === 'T' || device === 'C') return bit === undefined;
    return bit !== undefined || BIT_WORD_DEVICES.includes(device);
  }
  return bit === undefined && width !== 1;
}

/** Whether an XGT href (without its type) names a bit — what the AID type defaults to */
export function xgtIsBit(address: string): boolean {
  const upper = address.trim().toUpperCase();
  return /^%[A-Z]X/.test(upper) || /^[A-Z]\d+(\.[0-9A-F]|[A-F])$/.test(upper);
}
