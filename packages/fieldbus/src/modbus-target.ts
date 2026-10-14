/**
 * Modbus 주소 해석과 값 풀기 — 순수 함수(소켓 없음).
 *
 * 표기는 W3C WoT Modbus 바인딩을 따른다(AID IDTA-02017 이 그대로 쓴다):
 *   href = modbus+tcp://{장치}:{포트}/{unitID}/{주소}?quantity={개수}
 *   AID 에서는 base(EndpointMetadata) + href(forms) 로 나뉘어 오므로 둘을 합친다 — href 가 절대 주소면 그것,
 *   「/unit/주소」면 base 의 장치에, 「주소」만 있으면 base 경로의 unitID(없으면 modv_unitID, 그래도 없으면 1)에 붙인다.
 * 폼 항목(AID 에서는 modv_* 이름): entity(Coil · DiscreteInput · HoldingRegister · InputRegister) 또는 function,
 * type(xsd:*), mostSignificantByte · mostSignificantWord(원문 기본값 true).
 * zeroBasedAddressing 은 원문에서 폐지 예정이고 「TD 에는 쓰는 쪽이 그대로 쓸 주소를 적는다」 — 그래서 주소는 적힌 대로 쓰고,
 * 이 항목이 'false'(첫 레지스터가 1)로 **명시된** 경우에만 1 을 뺀다.
 */
import { fill, tr } from '@aas/core';

export type ModbusEntity = 'Coil' | 'DiscreteInput' | 'HoldingRegister' | 'InputRegister';

export interface ModbusTarget {
  host: string;
  port: number;
  unitId: number;
  /** 요청에 실을 0 기준 주소 */
  address: number;
  quantity: number;
  entity: ModbusEntity;
  /** xsd 자료형 — 접두 없이(boolean · short · unsignedShort · int · unsignedInt · float · double · integer · string · hexBinary) */
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

/** 폼 항목을 이름 접두(modv_ · modv:)와 상관없이 찾는다 */
function field(fields: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (key.replace(/^modv[_:]/, '').toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

const bool = (text: string | undefined, fallback: boolean): boolean => (text === undefined ? fallback : text.trim().toLowerCase() !== 'false');

/** 자료형이 차지하는 레지스터 수 — quantity 를 안 적었을 때 */
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

/** 레지스터(16비트 낱말들)를 자료형 값으로 */
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
      // integer · 모르는 자료형 — 낱말 수로 정한다(1 = 부호 있는 16비트, 2 = 32비트)
      return ordered.length >= 2 ? view.getInt32(0) : view.getInt16(0);
  }
}
