/**
 * Create collection connection — per-protocol differences (2026-10-14). The protocol is decided by the endpoint address (same rule as endpointProtocol in the server's aid-build),
 * and for Modbus the register kind and data type are chosen per row. Conventional addresses (40001 · 30010 · 00005 · 10003) are converted to kind + zero-based address.
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

/** Modbus data type → AID type (float · integer · boolean) */
export function aidTypeOf(dataType: string): string {
  if (dataType === 'xsd:boolean') return 'boolean';
  if (dataType === 'xsd:float' || dataType === 'xsd:double') return 'float';
  return 'integer';
}

/**
 * Conventional address (Modicon notation) → kind + zero-based address. Only 5 digits (40001) and 6 digits (400001) — the leading digit is the kind.
 * 0 = coil · 1 = discrete input · 3 = input register · 4 = holding register. Anything else is not converted (undefined).
 */
export function fromModiconAddress(text: string): { entity: ModbusEntityChoice; address: number } | undefined {
  const match = /^([0134])(\d{4,5})$/.exec(text.trim());
  if (!match) return undefined;
  const offset = Number(match[2]);
  if (offset < 1) return undefined;
  const entity = ({ '0': 'Coil', '1': 'DiscreteInput', '3': 'InputRegister', '4': 'HoldingRegister' } as const)[match[1] as '0' | '1' | '3' | '4'];
  return { entity, address: offset - 1 };
}
