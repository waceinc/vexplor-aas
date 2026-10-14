/**
 * Create collection connection — one tag row.
 * Split out of components/AddAid.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
export interface TagRow {
  name: string;
  href: string;
  type: string;
  /** Modbus only — register kind (modv_entity) and data type (modv_type) */
  entity?: string;
  dataType?: string;
}

export const EMPTY: TagRow = { name: '', href: '', type: 'float' };

