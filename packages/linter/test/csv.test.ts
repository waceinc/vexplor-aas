/** CSV 한 칸 — 엑셀 수식 주입을 막는다(2026-10-08 보안 점검) */
import { describe, expect, it } from 'vitest';
import { csvCell, linkageCsv, tableCsv } from '../src/index.js';

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
