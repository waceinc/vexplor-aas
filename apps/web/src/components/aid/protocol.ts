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

/** Word and byte order → the two Modbus binding flags. ABCD = high word first, high byte first (the binding default) */
export const MODBUS_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'] as const;
export function orderFields(order: (typeof MODBUS_ORDERS)[number] | undefined): Record<string, string> {
  if (order === undefined || order === 'ABCD') return {};
  return {
    modv_mostSignificantWord: order === 'CDAB' || order === 'DCBA' ? 'false' : 'true',
    modv_mostSignificantByte: order === 'BADC' || order === 'DCBA' ? 'false' : 'true',
  };
}
export function orderOf(fields: Record<string, string>): (typeof MODBUS_ORDERS)[number] {
  const word = (fields['modv_mostSignificantWord'] ?? 'true').toLowerCase() !== 'false';
  const byte = (fields['modv_mostSignificantByte'] ?? 'true').toLowerCase() !== 'false';
  return word ? (byte ? 'ABCD' : 'BADC') : byte ? 'CDAB' : 'DCBA';
}

/**
 * A user name or password inside an address (`mqtt://user:pass@host`, 2.8.0). The file would carry it and the server
 * leaves such a link out of the remote collector list, so the screen asks to take it out.
 */
const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i;
export const hasUserInfo = (endpoint: string): boolean => USER_INFO.test(endpoint.trim());
/** The address without its user name and password */
export const withoutUserInfo = (endpoint: string): string => endpoint.trim().replace(USER_INFO, '$1');
/** For display and exports — the password never shows on screen or in a CSV */
export const maskedEndpoint = (endpoint: string): string => endpoint.replace(USER_INFO, '$1***@');

/** The read period a link states, ms — the Modbus binding term or ours (`vxp_pollingTime`) on its forms */
export function statedPollingMs(properties: readonly { formFields?: Record<string, string> }[]): number | undefined {
  const stated = properties.flatMap((property) => {
    const text = property.formFields?.['modv_pollingTime'] ?? property.formFields?.['vxp_pollingTime'];
    const ms = Number(text);
    return text !== undefined && Number.isInteger(ms) && ms >= 100 ? [ms] : [];
  });
  return stated.length > 0 ? Math.min(...stated) : undefined;
}
