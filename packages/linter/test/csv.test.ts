/** A single CSV cell — blocks Excel formula injection (2026-10-08 security review) */
import { describe, expect, it } from 'vitest';
import { csvCell, linkageCsv, parseCsv, tableCsv } from '../src/index.js';

describe('Important: CSV formula injection — values from a third-party AASX never run as formulas in Excel', () => {
  it('prefixes text starting with = + - @ or tab with a single quote so it stays literal', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('\t=1')).toBe("'\t=1");
  });
  it('leaves numbers and plain text unchanged', () => {
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('+3')).toBe('+3');
    expect(csvCell('1e-3')).toBe('1e-3');
    expect(csvCell('SerialNumber')).toBe('SerialNumber');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('x', 'always')).toBe('"x"');
  });
  it('the documentation table and the linkage definition table go through this protection', () => {
    const table = tableCsv([{ depth: 0, idShort: 'P', modelType: 'Property', dataType: 'xs:string', unit: '', example: '=1+1', semanticId: '', description: '' }] as never);
    expect(table).toContain(`"'=1+1"`);
    const linkage = linkageCsv({ members: ['M'], items: [{ label: '@x', semanticId: 's', coverage: 1, points: { M: [{ path: 'p' }] } }] } as never);
    expect(linkage).toContain("'@x");
  });
});

describe('parseCsv — when filling values from an equipment register', () => {
  it('reads double quotes · commas and newlines inside a cell · "" escapes', () => {
    expect(parseCsv('Name,Note\nM1,"a, b"\nM2,"두 줄\n둘째"\nM3,"say ""hi"""\n')).toEqual([
      ['Name', 'Note'],
      ['M1', 'a, b'],
      ['M2', '두 줄\n둘째'],
      ['M3', 'say "hi"'],
    ]);
  });

  it('handles the Excel BOM, CRLF and blank lines', () => {
    expect(parseCsv('﻿A,B\r\n1,2\r\n\r\n3,4')).toEqual([['A', 'B'], ['1', '2'], ['3', '4']]);
  });

  it('also reads tab-separated text copied from Excel — when there are tabs and no commas', () => {
    expect(parseCsv('A\tB\n1,5\t2')).toEqual([['A', 'B'], ['1,5', '2']]);
  });

  it('a cell exported with csvCell reads back to the same value — the formula-guard quote is stripped', () => {
    const values = ['=HYPERLINK("x")', '-12.5', 'plain', 'a,b', '@cmd'];
    const line = values.map((value) => csvCell(value)).join(',');
    expect(parseCsv(line)[0]).toEqual(values);
  });
});
