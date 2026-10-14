/**
 * One CSV cell - shared by the tables downloaded from the UI (address list, documentation table, integration definitions,
 * collected values).
 *
 * Important: **guards against Excel formula injection (CSV Injection)** (security review 2026-10-08). If a value in someone
 *    else's AASX starts like `=HYPERLINK(...)` or `+cmd|...`, it runs as a formula on the PC of whoever opens the downloaded
 *    table in Excel. Such cells are prefixed with a single quote (') to make them text (OWASP recommendation).
 *    **Numbers** such as negatives (-12.5) are left as-is - if the value changes, the table loses its purpose.
 */
export function csvCell(value: string, quote: 'always' | 'needed' = 'needed'): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) text = `'${text}`;
  return quote === 'always' || /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV parsing - used to fill values from a table such as an equipment register (RFC 4180: double quotes, line breaks inside
 * cells, "" escapes).
 *
 * Strips the BOM that Excel adds, and picks the delimiter from the first line - tab if there is no comma but there is a tab
 * (pasted after copying from Excel). The single quote (') that csvCell adds to block formula injection is stripped on
 * read-back - re-uploading a downloaded table as-is yields the same values.
 * Empty lines are discarded.
 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const sep = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = (): void => {
    row.push(/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}
