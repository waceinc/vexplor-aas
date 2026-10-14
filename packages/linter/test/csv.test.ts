/** CSV 한 칸 — 엑셀 수식 주입을 막는다(2026-10-08 보안 점검) */
import { describe, expect, it } from 'vitest';
import { csvCell, linkageCsv, parseCsv, tableCsv } from '../src/index.js';

describe('🔴 CSV 수식 주입 — 남이 만든 AASX의 값이 엑셀에서 수식으로 돌지 않는다', () => {
  it('= + - @ 탭으로 시작하는 글은 작은따옴표를 붙여 글자로 만든다', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('\t=1')).toBe("'\t=1");
  });
  it('숫자와 보통 글은 그대로다', () => {
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('+3')).toBe('+3');
    expect(csvCell('1e-3')).toBe('1e-3');
    expect(csvCell('SerialNumber')).toBe('SerialNumber');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('x', 'always')).toBe('"x"');
  });
  it('문서용 표 · 연계 정의표가 이 보호를 거친다', () => {
    const table = tableCsv([{ depth: 0, idShort: 'P', modelType: 'Property', dataType: 'xs:string', unit: '', example: '=1+1', semanticId: '', description: '' }] as never);
    expect(table).toContain(`"'=1+1"`);
    const linkage = linkageCsv({ members: ['M'], items: [{ label: '@x', semanticId: 's', coverage: 1, points: { M: [{ path: 'p' }] } }] } as never);
    expect(linkage).toContain("'@x");
  });
});

describe('parseCsv — 설비 대장을 받아 값을 채울 때', () => {
  it('큰따옴표 · 칸 안 쉼표와 줄바꿈 · "" 이스케이프를 읽는다', () => {
    expect(parseCsv('Name,Note\nM1,"a, b"\nM2,"두 줄\n둘째"\nM3,"say ""hi"""\n')).toEqual([
      ['Name', 'Note'],
      ['M1', 'a, b'],
      ['M2', '두 줄\n둘째'],
      ['M3', 'say "hi"'],
    ]);
  });

  it('엑셀 BOM 과 CRLF, 빈 줄을 다룬다', () => {
    expect(parseCsv('﻿A,B\r\n1,2\r\n\r\n3,4')).toEqual([['A', 'B'], ['1', '2'], ['3', '4']]);
  });

  it('엑셀에서 복사한 탭 구분도 읽는다 — 쉼표가 없고 탭이 있을 때', () => {
    expect(parseCsv('A\tB\n1,5\t2')).toEqual([['A', 'B'], ['1,5', '2']]);
  });

  it('csvCell 로 내보낸 칸은 되읽으면 같은 값이다 — 수식 막이 작은따옴표를 뗀다', () => {
    const values = ['=HYPERLINK("x")', '-12.5', 'plain', 'a,b', '@cmd'];
    const line = values.map((value) => csvCell(value)).join(',');
    expect(parseCsv(line)[0]).toEqual(values);
  });
});
