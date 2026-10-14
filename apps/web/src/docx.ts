/**
 * A real .docx — without a library.
 *
 * Why the HTML-based `.doc` was dropped: **Word does not apply its page setup.**
 * Measured (Microsoft Word AppleScript) — the image width came in correctly at 482pt (17cm), but
 * `page setup` was empty. When the page opens as Letter the body width is 468pt, so the image overflows.
 * On top of that, Hangul (HWP) opens an HTML .doc even more unpredictably.
 *
 * A .docx is an **OPC package (zip + XML)** — the same structure this repository already produces for AASX, so
 * it can be built with no new dependency. Sizes are pinned in EMU, so Word and Hangul open it identically.
 *
 * Important: what this builds is **material for pasting**. Guidance prose is written by people.
 */
import { zipSync, strToU8 } from 'fflate';

/** 1cm = 360000 EMU (English Metric Unit) */
const EMU_PER_CM = 360000;
/** 1cm = 567 twip (1/20 pt) */
const TWIP_PER_CM = 567;

export interface DocxImage {
  kind: 'image';
  /** PNG bytes */
  data: Uint8Array;
  widthCm: number;
  heightCm: number;
  /** Left-aligned (logo). Centered by default */
  left?: boolean;
}

export interface DocxHeading {
  kind: 'heading';
  text: string;
  level: 1 | 2;
}

export interface DocxParagraph {
  kind: 'paragraph';
  text: string;
  bold?: boolean;
  center?: boolean;
  small?: boolean;
  gray?: boolean;
}

export interface DocxListItem {
  kind: 'bullet';
  text: string;
}

export interface DocxCell {
  /** Line breaks are given as an array */
  lines: string[];
  bold?: boolean;
  /** Header cell shading (same color as the document) */
  shaded?: boolean;
  /** How many columns to merge horizontally */
  span?: number;
}

export interface DocxTable {
  kind: 'table';
  rows: DocxCell[][];
  /** Column widths (cm). The sum must not exceed the body width */
  columns: number[];
}

export type DocxBlock = DocxImage | DocxHeading | DocxParagraph | DocxListItem | DocxTable;

export interface DocxOptions {
  title: string;
  /** Body width (cm) for A4 portrait. Default 17 (210 - 20 - 20mm) */
  contentWidthCm?: number;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Multiple lines as line breaks inside one paragraph */
function runsOf(lines: string[], bold?: boolean, size?: number): string {
  const properties =
    `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}` +
    // i18n-ignore — not screen text but the **font name** written into the Word document. Translating it breaks the document
    `<w:rFonts w:ascii="맑은 고딕" w:eastAsia="맑은 고딕" w:hAnsi="맑은 고딕"/></w:rPr>`;
  return lines
    .map(
      (line, index) =>
        `<w:r>${properties}${index > 0 ? '<w:br/>' : ''}` +
        `<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`,
    )
    .join('');
}

function paragraphXml(block: DocxParagraph | DocxHeading | DocxListItem): string {
  if (block.kind === 'heading') {
    const size = block.level === 1 ? 32 : 26; // half-point
    return (
      `<w:p><w:pPr><w:spacing w:before="${block.level === 1 ? 0 : 240}" w:after="120"/>` +
      `<w:outlineLvl w:val="${block.level - 1}"/></w:pPr>` +
      `${runsOf([block.text], true, size)}</w:p>`
    );
  }
  if (block.kind === 'bullet') {
    return (
      `<w:p><w:pPr><w:ind w:left="400" w:hanging="200"/></w:pPr>` +
      `${runsOf([`• ${block.text}`], false, 20)}</w:p>`
    );
  }
  const alignment = block.center ? '<w:jc w:val="center"/>' : '';
  const color = block.gray ? '' : '';
  return (
    `<w:p><w:pPr>${alignment}<w:spacing w:after="60"/></w:pPr>${color}` +
    `${runsOf([block.text], block.bold, block.small ? 18 : 20)}</w:p>`
  );
}

function tableXml(table: DocxTable): string {
  const grid = table.columns
    .map((width) => `<w:gridCol w:w="${Math.round(width * TWIP_PER_CM)}"/>`)
    .join('');

  const rows = table.rows
    .map((row) => {
      const cells = row
        .map((cell, index) => {
          const span = cell.span ?? 1;
          const width = table.columns
            .slice(index, index + span)
            .reduce((sum, value) => sum + value, 0);
          const borders =
            '<w:tcBorders>' +
            ['top', 'left', 'bottom', 'right']
              .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="808080"/>`)
              .join('') +
            '</w:tcBorders>';
          const shade = cell.shaded ? '<w:shd w:val="clear" w:fill="DAE9F7"/>' : '';
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${Math.round(width * TWIP_PER_CM)}" w:type="dxa"/>` +
            `${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${borders}${shade}` +
            `<w:vAlign w:val="center"/></w:tcPr>` +
            `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runsOf(cell.lines, cell.bold, 16)}</w:p></w:tc>`
          );
        })
        .join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function imageXml(block: DocxImage, id: number): string {
  const cx = Math.round(block.widthCm * EMU_PER_CM);
  const cy = Math.round(block.heightCm * EMU_PER_CM);
  return (
    `<w:p><w:pPr><w:jc w:val="${block.left ? 'left' : 'center'}"/><w:spacing w:after="60"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId${100 + id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

/** Block list to .docx bytes */
export function buildDocx(blocks: readonly DocxBlock[], options: DocxOptions): Uint8Array {
  const media: Record<string, Uint8Array> = {};
  const relationships: string[] = [];
  let imageId = 0;

  const body = blocks
    .map((block) => {
      if (block.kind === 'table') return tableXml(block);
      if (block.kind === 'image') {
        imageId += 1;
        media[`word/media/image${imageId}.png`] = block.data;
        relationships.push(
          `<Relationship Id="rId${100 + imageId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageId}.png"/>`,
        );
        return imageXml(block, imageId);
      }
      return paragraphXml(block);
    })
    .join('\n');

  // Important: pin the page size and margins in the document. This is exactly what HTML .doc could not do
  const width = options.contentWidthCm ?? 17;
  const sideMarginCm = (21 - width) / 2;
  const sectionProperties =
    `<w:sectPr>` +
    `<w:pgSz w:w="${Math.round(21 * TWIP_PER_CM)}" w:h="${Math.round(29.7 * TWIP_PER_CM)}"/>` +
    `<w:pgMar w:top="${Math.round(2 * TWIP_PER_CM)}" w:right="${Math.round(sideMarginCm * TWIP_PER_CM)}"` +
    ` w:bottom="${Math.round(2 * TWIP_PER_CM)}" w:left="${Math.round(sideMarginCm * TWIP_PER_CM)}"` +
    ` w:header="0" w:footer="0" w:gutter="0"/>` +
    `</w:sectPr>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>
${body}
${sectionProperties}
</w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.join('\n')}
</Relationships>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(options.title)}</dc:title>
<dc:creator>VEXPLOR AAS Studio</dc:creator>
</cp:coreProperties>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'docProps/core.xml': strToU8(core),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(documentRels),
    ...media,
  });
}
