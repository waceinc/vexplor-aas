/**
 * Collection panel — equipment rows of the process screen · download · value display · shortening failure reasons.
 * Split out of components/Collection.tsx (2026-10-13 componentization) — markup, comments and checks were moved verbatim.
 */
import type { CollectedValueView } from '../../api.js';
import { tr } from '../../i18n.js';


export interface EquipmentRow {
  name: string;
  /** Process › group path */
  group: string;
  bulkCount: number;
  /** Absent when the file is not open (planned) */
  packageId?: string;
  /** Whether a collection connection (AID) is attached */
  connected: boolean;
}

/** Hands one file to the browser (same approach as DocAssets) */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function displayValue(value: CollectedValueView): string {
  if (value.valueText !== undefined && value.valueText !== '') return value.valueText;
  if (value.valueNumber !== undefined) return String(value.valueNumber);
  return tr('(빈 값)');
}


/**
 * Collection report for one interface — including the "waiting for value" column.
 *
 * Important: the server (`CollectReport`) separates failures (`failures`) from **values that have not arrived yet** (`pending`).
 *    An empty list omits `pending` entirely, so absence reads as 0 — this does not break against an older server either.
 */
/** Shortens a failure reason to one token — `BadNodeIdUnknown (0x80340000)` → `BadNodeIdUnknown` */
export function shortReason(reason: string): string {
  const head = reason.split(/[\s(:]/)[0] ?? reason;
  return head.length > 0 && head.length <= 40 ? head : reason.slice(0, 40);
}
