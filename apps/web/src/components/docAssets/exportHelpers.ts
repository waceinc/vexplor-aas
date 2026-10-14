/**
 * Conversion helpers for documentation material — fit an image to A4 · SVG → PNG · download · table → .docx table.
 * Split out of components/DocAssets.tsx (2026-10-13 componentization) — code and comments were moved verbatim.
 */
import type { SmtTable } from '../../api.js';
import type { DocxCell, DocxTable } from '../../docx.js';
import { tr, fill } from '../../i18n.js';

/**
 * Size that fits one portrait A4 page (with 2 cm margins).
 * Important: if an image is larger than this, Word pushes it off the paper — it cannot be used in a document.
 */
export const A4_CONTENT_MM = { width: 170, height: 247 };

/**
 * Reads the SVG's original size and computes a size that fits within A4.
 *
 * Important: inserting into Word needs **px attributes**. Given only a CSS `style`, Word ignores it and
 *    uses the image's original pixel size (a PNG drawn at 2x becomes twice the paper).
 *    So both cm and px are returned, and they are also stamped as `<img width height>` attributes.
 */
export function fitToA4(svg: string): { widthCm: number; heightCm: number; widthPx: number; heightPx: number } {
  const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const height = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const fallback = { widthCm: 17, heightCm: 0, widthPx: 643, heightPx: 0 };
  if (width <= 0 || height <= 0) return fallback;

  // SVG coordinates are px (96 dpi) → mm
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

/** Putting an image on the clipboard requires PNG — the SVG is drawn on a canvas to convert it (no library) */
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
    // If the document size is known, draw at twice that size — sharp on screen without making the file large
    const factor = targetWidthPx ? (targetWidthPx * 2) / image.width : scale;
    canvas.width = Math.round(image.width * factor);
    canvas.height = Math.round(image.height * factor);
    const context = canvas.getContext('2d');
    if (!context) throw new Error(tr('캔버스를 열지 못했습니다.'));
    // Documents are white paper — with a transparent background the text is invisible after pasting
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

/** One table to a Word table. Column widths are divided within the A4 body width (17 cm) */
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
