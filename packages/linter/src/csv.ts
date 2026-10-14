/**
 * CSV 한 칸 — 화면에서 내려받는 표(주소 목록 · 문서용 표 · 연계 정의 · 수집값)가 함께 쓴다.
 *
 * 🔴 **엑셀 수식 주입(CSV Injection)을 막는다**(2026-10-08 보안 점검). 남이 만든 AASX의 값이
 *    `=HYPERLINK(...)`·`+cmd|...`처럼 시작하면, 받은 표를 엑셀로 여는 사람의 PC에서 수식으로
 *    돌아간다. 그런 칸은 앞에 작은따옴표(')를 붙여 글자로 만든다(OWASP 권고).
 *    음수 같은 **숫자**(-12.5)는 그대로 둔다 — 값이 바뀌면 표를 쓰는 의미가 없다.
 */
export function csvCell(value: string, quote: 'always' | 'needed' = 'needed'): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) text = `'${text}`;
  return quote === 'always' || /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV 읽기 — 설비 대장 같은 표를 받아 값을 채울 때 쓴다(RFC 4180: 큰따옴표 · 칸 안 줄바꿈 · "" 이스케이프).
 *
 * 엑셀이 붙이는 BOM 을 떼고, 구분자는 첫 줄에서 고른다 — 쉼표가 없고 탭이 있으면 탭(엑셀에서 복사해 붙여 넣은 경우).
 * csvCell 이 수식 주입을 막으려고 붙인 작은따옴표(')는 되읽을 때 뗀다 — 내려받은 표를 그대로 다시 올려도 값이 같다.
 * 빈 줄은 버린다.
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
