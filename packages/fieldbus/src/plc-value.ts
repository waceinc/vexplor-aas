/**
 * PLC bytes → typed value, for the S7, MC and XGT readers.
 *
 * S7 is big-endian throughout (high byte first, as a DB shows it). MELSEC words are little-endian and a value that
 * spans words puts its low word first — so a MELSEC value is simply little-endian over all its bytes, the order the
 * 3E frame returns them in. XGT is read the same way: the manual states its frame fields little-endian ("h0054 ⇒
 * 5400") and maps a word onto two byte addresses (`%DW1234` = `%DB2468`), but it does not show the byte order of word
 * data — little-endian there is our reading, to be confirmed on a real CPU. XGT strings are read like MELSEC's.
 */
import type { PlcProtocolName, PlcValueType } from '@aas/collector';

/** Decodes a non-BOOL value. `bytes` starts at the value and holds at least its width */
export function decodePlcValue(bytes: Uint8Array, value: PlcValueType, littleEndian: boolean, protocol: PlcProtocolName): number | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (value.type) {
    case 'BYTE':
    case 'USINT':
      return view.getUint8(0);
    case 'SINT':
      return view.getInt8(0);
    case 'CHAR':
      return String.fromCharCode(view.getUint8(0));
    case 'WORD':
    case 'UINT':
      return view.getUint16(0, littleEndian);
    case 'INT':
      return view.getInt16(0, littleEndian);
    case 'DWORD':
    case 'UDINT':
      return view.getUint32(0, littleEndian);
    case 'DINT':
      return view.getInt32(0, littleEndian);
    case 'REAL':
      // Same rounding as Modbus float — a 32-bit float printed with 17 digits shows noise nobody wrote
      return Number(view.getFloat32(0, littleEndian).toPrecision(7));
    case 'LREAL':
      return view.getFloat64(0, littleEndian);
    case 'LINT':
      return Number(view.getBigInt64(0, littleEndian));
    case 'ULINT':
      return Number(view.getBigUint64(0, littleEndian));
    case 'STRING':
      return protocol === 'S7' ? s7String(bytes) : mcString(bytes, value.length ?? bytes.length);
    default:
      throw new Error(`Unsupported type ${value.type}`);
  }
}

/** S7 STRING: byte 0 = declared maximum, byte 1 = current length, then the characters (single-byte) */
function s7String(bytes: Uint8Array): string {
  const max = bytes[0] ?? 0;
  const length = Math.min(bytes[1] ?? 0, max, Math.max(0, bytes.length - 2));
  return Buffer.from(bytes.subarray(2, 2 + length)).toString('latin1');
}

/** MELSEC string: characters in device order (low byte of each word first), ending at the first NUL */
function mcString(bytes: Uint8Array, length: number): string {
  const chars = bytes.subarray(0, Math.min(length, bytes.length));
  const end = chars.indexOf(0);
  return Buffer.from(end < 0 ? chars : chars.subarray(0, end)).toString('latin1');
}
