/**
 * 문서용 자료의 변환 도우미 — 그림을 A4 에 맞추기 · SVG → PNG · 내려받기 · 표 → .docx 표.
 * components/DocAssets.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다.
 */
import type { SmtTable } from '../../api.js';
import type { DocxCell, DocxTable } from '../../docx.js';
import { tr, fill } from '../../i18n.js';

/**
 * A4 세로 한 쪽에 들어가는 크기(여백 2cm 기준).
 * 🔴 그림이 이보다 크면 워드가 종이 밖으로 밀어낸다 — 문서에 못 쓴다.
 */
export const A4_CONTENT_MM = { width: 170, height: 247 };

/**
 * SVG의 원래 크기를 읽어 A4 안에 들어갈 크기를 구한다.
 *
 * 🔴 워드에 넣을 때는 **px 속성**이 있어야 한다. CSS `style`만 주면 워드가 무시하고
 *    그림의 원래 픽셀 크기를 그대로 쓴다(2배로 그린 PNG면 종이의 2배가 된다).
 *    그래서 cm와 px를 함께 돌려주고, `<img width height>` 속성으로도 박는다.
 */
export function fitToA4(svg: string): { widthCm: number; heightCm: number; widthPx: number; heightPx: number } {
  const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const height = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const fallback = { widthCm: 17, heightCm: 0, widthPx: 643, heightPx: 0 };
  if (width <= 0 || height <= 0) return fallback;

  // SVG 좌표는 px(96dpi)다 → mm
  const widthMm = (width / 96) * 25.4;
  const heightMm = (height / 96) * 25.4;
  const scale = Math.min(1, A4_CONTENT_MM.width / widthMm, A4_CONTENT_MM.height / heightMm);
  const finalWidthMm = widthMm * scale;
  const finalHeightMm = heightMm * scale;
  return {
    widthCm: finalWidthMm / 10,
    heightCm: finalHeightMm / 10,
    widthPx: Math.round((finalWidthMm / 25.4) * 96),
    heightPx: Math.round((finalHeightMm / 25.4) * 96),
  };
}

/** 클립보드에 그림을 넣으려면 PNG여야 한다 — SVG를 캔버스에 그려 바꾼다(라이브러리 없이) */
export async function svgToPngBlob(svg: string, scale = 2, targetWidthPx?: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(tr('그림을 읽지 못했습니다.')));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    // 문서에 들어갈 크기를 알면 그 크기의 2배로 그린다 — 화면에서 선명하고 파일도 커지지 않는다
    const factor = targetWidthPx ? (targetWidthPx * 2) / image.width : scale;
    canvas.width = Math.round(image.width * factor);
    canvas.height = Math.round(image.height * factor);
    const context = canvas.getContext('2d');
    if (!context) throw new Error(tr('캔버스를 열지 못했습니다.'));
    // 문서는 흰 종이다 — 투명 배경으로 두면 붙여넣은 뒤 글자가 안 보인다
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(tr('PNG로 바꾸지 못했습니다.')))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 표 한 장을 워드 표로. 열 너비는 A4 본문(17cm) 안에서 나눈다 */
export function toDocxTable(table: SmtTable): DocxTable {
  const columns = [3.6, 7.4, 4.0, 2.0];
  const semanticLines = (cell: SmtTable['semantic']): string[] => {
    if (cell.id === '') return ['-'];
    const lines = [`${cell.idType} ${cell.id}`];
    if (cell.definition !== '') lines.push(cell.definition);
    if (cell.korean !== '') lines.push(cell.korean);
    if (cell.idtaOrigin !== '') lines.push(fill(tr('IDTA 원본: {0}'), { 0: cell.idtaOrigin }));
    return lines;
  };

  const label = (text: string): DocxCell => ({ lines: [text], bold: true, shaded: true });
  const rows: DocxCell[][] = [
    [label('idShort:'), { lines: [table.idShort], span: 3 }],
    [label('Class:'), { lines: [table.className], span: 3 }],
    [label('semanticId:'), { lines: semanticLines(table.semantic), span: 3 }],
    [label('Parent:'), { lines: [table.parent], span: 3 }],
    [label('Explanation:'), { lines: [table.explanation], span: 3 }],
    [
      label('[SME type]idShort'),
      { lines: ['semanticId = [idType]value', 'Description@en'], bold: true, shaded: true },
      { lines: ['[valueType]example'], bold: true, shaded: true },
      { lines: ['card.'], bold: true, shaded: true },
    ],
  ];
  for (const child of table.children) {
    rows.push([
      { lines: [child.label] },
      { lines: semanticLines(child.semantic) },
      { lines: [child.value] },
      { lines: [child.cardinality] },
    ]);
  }
  return { kind: 'table', rows, columns };
}
