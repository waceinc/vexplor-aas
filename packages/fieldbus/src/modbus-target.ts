/**
 * Modbus address resolution and value decoding — pure functions (no sockets).
 *
 * Notation follows the W3C WoT Modbus binding (used as-is by AID IDTA-02017):
 *   href = modbus+tcp://{device}:{port}/{unitID}/{address}?quantity={count}
 *   In AID it arrives split into base (EndpointMetadata) + href (forms), so the two are combined — if href is absolute, use it;
 *   "/unit/address" attaches to the base device; a bare "address" attaches to the unitID in the base path (else modv_unitID, else 1).
 * Form fields (named modv_* in AID): entity (Coil / DiscreteInput / HoldingRegister / InputRegister) or function,
 * type (xsd:*), mostSignificantByte / mostSignificantWord (default true per the original spec).
 * zeroBasedAddressing is slated for deprecation in the original spec, and "the TD states the address the consumer uses as-is" — so addresses
 * are used as written, and 1 is subtracted only when this field is **explicitly** 'false' (first register is 1).
 */
import { fill, tr } from '@aas/core';

export type ModbusEntity = 'Coil' | 'DiscreteInput' | 'HoldingRegister' | 'InputRegister';

export interface ModbusTarget {
  host: string;
  port: number;
  unitId: number;
  /** Zero-based address sent in the request */
  address: number;
  quantity: number;
  entity: ModbusEntity;
  /** xsd data type — without prefix (boolean, short, unsignedShort, int, unsignedInt, float, double, integer, string, hexBinary) */
  type: string;
  msb: boolean;
  msw: boolean;
}

const FUNCTION_ENTITY: Record<string, ModbusEntity> = {
  readcoil: 'Coil',
  readcoils: 'Coil',
  readdevicediscreteinput: 'DiscreteInput',
  readdiscreteinput: 'DiscreteInput',
  readdiscreteinputs: 'DiscreteInput',
  readholdingregisters: 'HoldingRegister',
  readholdingregister: 'HoldingRegister',
  readinputregisters: 'InputRegister',
  readinputregister: 'InputRegister',
};

/** Looks up a form field regardless of its name prefix (modv_ or modv:) */
function field(fields: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (key.replace(/^modv[_:]/, '').toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

const bool = (text: string | undefined, fallback: boolean): boolean => (text === undefined ? fallback : text.trim().toLowerCase() !== 'false');

/** Number of registers a data type occupies — used when quantity is not given */
function registersFor(type: string): number {
  if (type === 'int' || type === 'unsignedInt' || type === 'float') return 2;
  if (type === 'double' || type === 'long' || type === 'unsignedLong') return 4;
  return 1;
}

export function modbusTarget(base: string | undefined, href: string, fields: Record<string, string> = {}): ModbusTarget {
  const absolute = /^modbus\+tcp:\/\//i.test(href);
  if (!absolute && !base) throw new Error(tr('Modbus 접속 주소(base)가 없습니다.'));
  const baseUrl = new URL(absolute ? href : base!.replace(/^modbus\+tcp:/i, 'http:'));
  const host = baseUrl.hostname;
  const port = baseUrl.port ? Number(baseUrl.port) : 502;
  const basePath = absolute ? [] : baseUrl.pathname.split('/').filter(Boolean);
  const [hrefPath = '', query = ''] = (absolute ? href.replace(/^modbus\+tcp:\/\/[^/]+/i, '') : href).split('?');
  const segments = hrefPath.split('/').filter(Boolean);
  let unitText: string | undefined;
  let addressText: string | undefined;
  if (segments.length >= 2) [unitText, addressText] = segments.slice(-2);
  else {
    addressText = segments[0];
    unitText = basePath[basePath.length - 1] ?? field(fields, 'unitID');
  }
  const unitId = Number(unitText ?? 1);
  let address = Number(addressText);
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) throw new Error(fill(tr('unitID 가 잘못됐습니다: {0}'), { 0: String(unitText) }));
  if (!Number.isInteger(address) || address < 0 || address > 65535) throw new Error(fill(tr('Modbus 주소가 잘못됐습니다: {0}'), { 0: href }));
  if (field(fields, 'zeroBasedAddressing')?.trim().toLowerCase() === 'false') address -= 1;
  if (address < 0) throw new Error(fill(tr('Modbus 주소가 잘못됐습니다: {0}'), { 0: href }));

  const entityText = field(fields, 'entity');
  const functionText = field(fields, 'function');
  const entity: ModbusEntity =
    (['Coil', 'DiscreteInput', 'HoldingRegister', 'InputRegister'] as const).find((name) => name.toLowerCase() === entityText?.toLowerCase()) ??
    FUNCTION_ENTITY[(functionText ?? '').toLowerCase()] ??
    'HoldingRegister';
  const bitEntity = entity === 'Coil' || entity === 'DiscreteInput';
  const type = (field(fields, 'type') ?? (bitEntity ? 'xsd:boolean' : 'xsd:integer')).replace(/^xsd:/, '');
  const quantityParam = new URLSearchParams(query).get('quantity');
  const quantity = quantityParam !== null ? Number(quantityParam) : bitEntity ? 1 : registersFor(type);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 125) throw new Error(fill(tr('quantity 가 잘못됐습니다: {0}'), { 0: String(quantityParam) }));
  return { host, port, unitId, address, quantity, entity, type, msb: bool(field(fields, 'mostSignificantByte'), true), msw: bool(field(fields, 'mostSignificantWord'), true) };
}

/** Registers (16-bit words) -> typed value */
export function decodeRegisters(words: readonly number[], target: Pick<ModbusTarget, 'type' | 'msb' | 'msw'>): number | string | boolean {
  const ordered = target.msw ? [...words] : [...words].reverse();
  const bytes = new Uint8Array(ordered.length * 2);
  ordered.forEach((word, index) => {
    const hi = (word >> 8) & 0xff;
    const lo = word & 0xff;
    bytes[index * 2] = target.msb ? hi : lo;
    bytes[index * 2 + 1] = target.msb ? lo : hi;
  });
  const view = new DataView(bytes.buffer);
  switch (target.type) {
    case 'boolean':
      return (words[0] ?? 0) !== 0;
    case 'short':
      return view.getInt16(0);
    case 'unsignedShort':
      return view.getUint16(0);
    case 'int':
      return view.getInt32(0);
    case 'unsignedInt':
      return view.getUint32(0);
    case 'float':
      return Number(view.getFloat32(0).toPrecision(7));
    case 'double':
      return view.getFloat64(0);
    case 'long':
      return Number(view.getBigInt64(0));
    case 'unsignedLong':
      return Number(view.getBigUint64(0));
    case 'hexBinary':
      return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    case 'string':
      return new TextDecoder().decode(bytes).replace(/\0+$/, '');
    default:
      // integer or unknown data type — decided by word count (1 = signed 16-bit, 2 = 32-bit)
      return ordered.length >= 2 ? view.getInt32(0) : view.getInt16(0);
  }
}
