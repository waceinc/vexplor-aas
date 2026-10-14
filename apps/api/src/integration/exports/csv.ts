/**
 * CSV writing for the integration exports (design §4.4, ERP §5.2, E-4, E-13).
 *
 * RFC 4180 through the shared `csvCell` (which also neutralises formula injection), CRLF line ends, `.` decimals,
 * booleans `true` / `false`, multi-values joined with `;`. Inside a multi-value `\` and `;` are escaped as `\\` and `\;`
 * so the list splits back exactly (`splitMulti`). `bom=1` prepends the UTF-8 BOM that Excel-based Korean upload screens
 * need; `meta=1` adds a `#schema=…` first line (off by default — some ERP uploaders reject comment lines).
 *
 * Important: spreadsheets in many locales use `;` as the delimiter. A cell holding `a;=1+1` would then split and the
 *    second part run as a formula. So every list element gets the same formula guard as a whole cell (a leading `'`),
 *    and every cell containing `;` is quoted.
 */
import { csvCell } from '@aas/linter';
import type { ApiResponse } from '../../http.js';
import { columnLabel } from './columns.js';

export type CsvValue = string | number | boolean | null | undefined | readonly string[];
export type CsvRow = Record<string, CsvValue>;

export interface CsvOptions {
  bom: boolean;
  /** `keys` = the contract; `ko` = human labels in the request language */
  headers: 'keys' | 'ko';
  meta: boolean;
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** The `csvCell` guard for one list element: text that would start a formula gets a leading `'`; numbers stay */
function guardElement(value: string): string {
  return FORMULA_START.test(value) && !NUMBER.test(value) ? `'${value}` : value;
}

export function joinMulti(values: readonly string[]): string {
  return values.map((value) => guardElement(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;')).join(';');
}

/** Inverse of `joinMulti` — an empty cell is an empty list */
export function splitMulti(text: string): string[] {
  if (text === '') return [];
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1]!;
      i += 1;
    } else if (ch === ';') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  // Undo the element guard, as parseCsv does for whole cells
  return out.map((value) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value));
}

export function cellText(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return joinMulti(value as readonly string[]);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

/** `csvCell`, plus quoting for `;` (see the file header) */
function csvField(text: string): string {
  return csvCell(text, text.includes(';') ? 'always' : 'needed');
}

export function toCsvText(columns: readonly string[], rows: readonly CsvRow[], options: CsvOptions & { schema: string }): string {
  const lines: string[] = [];
  if (options.meta) lines.push(`#schema=${options.schema}`);
  lines.push(columns.map((key) => csvCell(options.headers === 'ko' ? columnLabel(key) : key)).join(','));
  for (const row of rows) lines.push(columns.map((key) => csvField(cellText(row[key]))).join(','));
  return `${options.bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}

export function csvOptionsOf(query: Record<string, string>): CsvOptions {
  return { bom: query['bom'] === '1', headers: query['headers'] === 'ko' ? 'ko' : 'keys', meta: query['meta'] === '1' };
}

/** `vexplor.equipmentMaster/1` + date → `vexplor.equipmentMaster-1-2026-10-14.csv` */
export function exportFileName(schema: string, exportedAt: string, extension: string): string {
  return `${schema.replace(/[^A-Za-z0-9._-]+/g, '-')}-${exportedAt.slice(0, 10)}.${extension}`;
}

export function csvResponse(text: string, schema: string, exportedAt: string): ApiResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFileName(schema, exportedAt, 'csv')}"`,
    },
    body: new TextEncoder().encode(text),
  };
}
