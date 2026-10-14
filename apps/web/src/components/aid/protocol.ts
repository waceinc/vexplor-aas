/**
 * 수집 연결 만들기 — 프로토콜별 차이(2026-10-14). 접속 주소로 프로토콜을 정하고(서버 aid-build 의 endpointProtocol 과 같은 규칙),
 * Modbus 는 레지스터 종류 · 자료형을 줄마다 고른다. 관례 주소(40001 · 30010 · 00005 · 10003)는 종류와 0 기준 주소로 바꿔 준다.
 */
export type AidProtocolChoice = 'OPCUA' | 'MODBUS' | 'MQTT';

export function protocolOfEndpoint(endpoint: string): AidProtocolChoice | undefined {
  const text = endpoint.trim();
  if (/^opc\.tcp:\/\/.+/i.test(text)) return 'OPCUA';
  if (/^modbus\+tcp:\/\/.+/i.test(text)) return 'MODBUS';
  if (/^mqtts?:\/\/.+/i.test(text)) return 'MQTT';
  return undefined;
}

export type ModbusEntityChoice = 'HoldingRegister' | 'InputRegister' | 'Coil' | 'DiscreteInput';
export const MODBUS_ENTITIES: readonly ModbusEntityChoice[] = ['HoldingRegister', 'InputRegister', 'Coil', 'DiscreteInput'];
export const MODBUS_TYPES = ['xsd:unsignedShort', 'xsd:short', 'xsd:unsignedInt', 'xsd:int', 'xsd:float', 'xsd:double', 'xsd:boolean'] as const;

/** Modbus 자료형 → AID 의 type(float · integer · boolean) */
export function aidTypeOf(dataType: string): string {
  if (dataType === 'xsd:boolean') return 'boolean';
  if (dataType === 'xsd:float' || dataType === 'xsd:double') return 'float';
  return 'integer';
}

/**
 * 관례 주소(Modicon 표기) → 종류 + 0 기준 주소. 5자리(40001)와 6자리(400001)만 — 앞자리가 종류다.
 * 0 = 코일 · 1 = 입력 비트 · 3 = 입력 레지스터 · 4 = 보유 레지스터. 그 밖은 바꾸지 않는다(undefined).
 */
export function fromModiconAddress(text: string): { entity: ModbusEntityChoice; address: number } | undefined {
  const match = /^([0134])(\d{4,5})$/.exec(text.trim());
  if (!match) return undefined;
  const offset = Number(match[2]);
  if (offset < 1) return undefined;
  const entity = ({ '0': 'Coil', '1': 'DiscreteInput', '3': 'InputRegister', '4': 'HoldingRegister' } as const)[match[1] as '0' | '1' | '3' | '4'];
  return { entity, address: offset - 1 };
}
