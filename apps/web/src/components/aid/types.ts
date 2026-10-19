/**
 * Create collection connection — one tag row.
 * Split out of components/AddAid.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
export interface TagRow {
  name: string;
  href: string;
  type: string;
  /** Unit (UCUM: rpm · Cel · bar …) — optional, written to the AID `unit` (2.8.0) */
  unit?: string;
  /** Modbus only — register kind (modv_entity) and data type (modv_type) */
  entity?: string;
  dataType?: string;
  /**
   * Modbus only — word and byte order of multi-register values (modv_mostSignificantWord / Byte, 2.8.0).
   * ABCD (default, high word and byte first) · CDAB · BADC · DCBA — the names Modbus tools use.
   */
  order?: ModbusOrder;
  /** S7 · MC only — the PLC data type joined to the address on "Create" (`DB10.DBD4` + `REAL`); '' = the address default */
  plcType?: string;
  /** Form fields kept from an existing link ("Edit link") that the screen does not show — written back unchanged */
  keep?: Record<string, string>;
}

export type ModbusOrder = 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';

export const EMPTY: TagRow = { name: '', href: '', type: 'float' };

