/**
 * Submodel UML class diagram (SVG).
 *
 * Basis: KTL regulation §13, caution 3 — **attach a UML Diagram for every submodel**.
 * Important: the layout follows "Figures 14–20, submodel UML diagrams" from actual submitted guidance
 *    (01-Roll Forming Machine V4.0 · [Attachment 1] Mechanical Press V2.0) exactly. Drawn to my own taste,
 *    it would clash with the surrounding figures in the document.
 *
 * Rules of that figure:
 *  ① An outer frame with `SMT <submodel name>` in the top-left tab
 *  ② Class box = «stereotype» (SM, SMC, SML) + name + divider + **attribute compartment**
 *  ③ One attribute line = `+ name : type = "value"` — leaves (Property, MLP) include the value, containers only the type
 *  ④ **Only container elements get their own box.** Leaves appear only as attribute lines in the parent box
 *  ⑤ Flows left to right, connected by composition (◆). Multiplicity (0..1 · 1..*) on the child side
 *  ⑥ White background, black lines. The document is white paper
 *
 * Writes SVG directly without a library — it is only boxes and lines, so no reason to add a dependency.
 */
import { fill, tr, type Environment, type Submodel, type SubmodelElement } from '@aas/core';

export interface UmlOptions {
  /**
   * How many levels to expand into boxes. Default {@link DEFAULT_MAX_DEPTH}.
   *
   * Important: the old default of 3 **truncated real files** (measured 2026-09-21). 3 of the 7 golden files
   *    lost their inner parts — HandoverDocumentation 6→10 · TechnicalData 8→14 ·
   *    MaintenanceInstructions 12→15 boxes. TechnicalData in particular kept only shells like
   *    `RollGeometry : SMC` and **showed not a single actual spec value**. Being an equipment-specific
   *    submodel, it was exactly the figure whose values must be visible in the guidance.
   */
  maxDepth?: number;
  /** Number of attribute lines per box. Overflow becomes "… N more" */
  maxAttributes?: number;
  /** Base font size (px) */
  fontSize?: number;
  /** Maximum value length in an attribute line */
  valueLimit?: number;
}

/**
 * Default depth expanded into boxes.
 *
 * Expanding containers **all the way down** is correct, but a cap remains — in an abnormally deep file
 * the figure would grow without bound, the A4 scale-down factor would drop, and text would smear.
 * The measured maximum is 5 levels (HandoverDocumentation), so 8 leaves headroom.
 */
const DEFAULT_MAX_DEPTH = 8;

/** Only container elements get boxes */
const CONTAINERS = new Set([
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
  'AnnotatedRelationshipElement',
]);

/** Abbreviations used in actual documents */
const SHORT: Record<string, string> = {
  Submodel: 'SM',
  SubmodelElementCollection: 'SMC',
  SubmodelElementList: 'SML',
  MultiLanguageProperty: 'MLP',
  ReferenceElement: 'Ref',
  RelationshipElement: 'Rel',
  AnnotatedRelationshipElement: 'ARel',
  BasicEventElement: 'Event',
  Entity: 'Entity',
  Property: 'Property',
  Range: 'Range',
  File: 'File',
  Blob: 'Blob',
  Capability: 'Capability',
  Operation: 'Operation',
};

interface Node {
  stereotype: string;
  name: string;
  attributes: string[];
  children: Node[];
  /**
   * Multiplicity on the line entering this box.
   * Important: determined by what the **parent** is — `1..*` if it is a child of a list (SML), otherwise `0..1`.
   *    That is how the document's figure does it: `SM ◆—0..1— Markings(SML) ◆—1..*— Marking(SMC)`
   */
  multiplicity: string;
}

interface Placed extends Node {
  x: number;
  y: number;
  width: number;
  height: number;
  children: Placed[];
}

function raw(node: SubmodelElement): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

function childrenOf(node: SubmodelElement): SubmodelElement[] {
  const record = raw(node);
  // The root (submodel) holds its children under a different name
  if (Array.isArray(record['submodelElements'])) {
    return record['submodelElements'] as SubmodelElement[];
  }
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(record['value']) ? (record['value'] as SubmodelElement[]) : [];
  }
  if (node.modelType === 'Entity') {
    return Array.isArray(record['statements']) ? (record['statements'] as SubmodelElement[]) : [];
  }
  if (node.modelType === 'AnnotatedRelationshipElement') {
    return Array.isArray(record['annotations']) ? (record['annotations'] as SubmodelElement[]) : [];
  }
  return [];
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/** Value of an attribute line — the document writes it as `= "value"` */
function valueOf(node: SubmodelElement, limit: number): string | undefined {
  const record = raw(node);
  if (node.modelType === 'MultiLanguageProperty') {
    const list = (record['value'] as { language: string; text: string }[] | undefined) ?? [];
    const pick = list.find((entry) => entry.language.toLowerCase().startsWith('ko')) ?? list[0];
    return pick ? clip(pick.text, limit) : undefined;
  }
  if (node.modelType === 'Range') {
    const min = String(record['min'] ?? '');
    const max = String(record['max'] ?? '');
    return min === '' && max === '' ? undefined : clip(`${min}~${max}`, limit);
  }
  if (typeof record['value'] === 'string' && record['value'] !== '') {
    return clip(record['value'], limit);
  }
  return undefined;
}

/** One attribute line — `+ name : type = "value"` */
function attributeLine(
  node: SubmodelElement,
  index: number,
  limit: number,
  nameOverride?: string,
): string {
  const record = raw(node);
  const name = nameOverride ?? node.idShort ?? `[${index}]`;
  const type =
    node.modelType === 'Property' || node.modelType === 'Range'
      ? String(record['valueType'] ?? 'xs:string')
      : (SHORT[node.modelType] ?? node.modelType);
  const value = valueOf(node, limit);
  return value === undefined ? `+ ${name} : ${type}` : `+ ${name} : ${type} = "${value}"`;
}

/**
 * Children of a SubmodelElementList all have the same shape, so **only one representative** is drawn (the document
 * does the same). The name drops index suffixes like `MarkingsEntry_0`, and drops the plural s if it would
 * otherwise equal the list name.
 */
function listItemName(listName: string, first: SubmodelElement | undefined, index: number): string {
  const base = (first?.idShort ?? '').replace(/Entry_?\d+$/, '').replace(/_\d+$/, '');
  const candidate = base === '' ? listName : base;
  if (candidate === listName && candidate.endsWith('s')) return candidate.slice(0, -1);
  return candidate === '' ? `Item${index}` : candidate;
}

function toNode(
  element: SubmodelElement,
  depth: number,
  options: Required<UmlOptions>,
  displayName: string,
  incoming: string,
): Node {
  const kids = childrenOf(element);
  const isList = element.modelType === 'SubmodelElementList';
  // List children all have the same shape, so only one representative is drawn (the document does the same)
  const shown = isList ? kids.slice(0, 1) : kids;
  /** List children are named with the index suffix removed — `MarkingsEntry_0` → `Marking` */
  const nameOf = (child: SubmodelElement, index: number): string =>
    isList ? listItemName(element.idShort ?? '', child, index) : (child.idShort ?? `[${index}]`);

  const attributes = shown
    .slice(0, options.maxAttributes)
    .map((child, index) => attributeLine(child, index, options.valueLimit, nameOf(child, index)));
  if (shown.length > options.maxAttributes) {
    attributes.push(fill(tr('… 그 밖 {0}개'), { 0: shown.length - options.maxAttributes }));
  }

  const containerKids =
    depth >= options.maxDepth ? [] : shown.filter((child) => CONTAINERS.has(child.modelType));

  return {
    stereotype: SHORT[element.modelType] ?? element.modelType,
    name: displayName,
    attributes,
    multiplicity: incoming,
    children: containerKids.map((child) => {
      const index = shown.indexOf(child);
      return toNode(
        child,
        depth + 1,
        options,
        nameOf(child, index),
        // Important: a child of a list gets 1..* — multiplicity is decided by the parent
        isList ? '1..*' : '0..1',
      );
    }),
  };
}

const PAD = 18;
const COL_GAP = 74;
const ROW_GAP = 18;
const FRAME_PAD = 22;

function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of text) units += character.charCodeAt(0) > 0x2e80 ? 1 : 0.54;
  return units * fontSize;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderUml(root: Node, frameLabel: string, options: UmlOptions = {}): string {
  const fontSize = options.fontSize ?? 13;
  const attrSize = fontSize - 1;
  const lineHeight = attrSize + 8;
  const headerHeight = fontSize + attrSize + 22;

  // ① Box sizes
  const measure = (node: Node): Placed => {
    const width =
      Math.max(
        textWidth(node.name, fontSize + 2) + 40,
        ...node.attributes.map((line) => textWidth(line, attrSize) + 28),
        140,
      ) | 0;
    const height = headerHeight + (node.attributes.length > 0 ? node.attributes.length * lineHeight + 8 : 0);
    return { ...node, x: 0, y: 0, width, height, children: node.children.map(measure) };
  };
  const placed = measure(root);

  // ② Column x coordinates — fit to the widest box at each depth
  const widthByDepth: number[] = [];
  const scanWidth = (node: Placed, depth: number): void => {
    widthByDepth[depth] = Math.max(widthByDepth[depth] ?? 0, node.width);
    for (const child of node.children) scanWidth(child, depth + 1);
  };
  scanWidth(placed, 0);
  const xByDepth: number[] = [];
  let cursorX = PAD + FRAME_PAD;
  widthByDepth.forEach((width, depth) => {
    xByDepth[depth] = cursorX;
    cursorX += width + COL_GAP;
  });

  // ③ y coordinates — place the parent at the center of its group of children
  let cursorY = PAD + FRAME_PAD + 10;
  const layout = (node: Placed, depth: number): void => {
    node.x = xByDepth[depth]!;
    if (node.children.length === 0) {
      node.y = cursorY;
      cursorY += node.height + ROW_GAP;
      return;
    }
    const startY = cursorY;
    for (const child of node.children) layout(child, depth + 1);
    const first = node.children[0]!;
    const last = node.children[node.children.length - 1]!;
    const center = (first.y + last.y + last.height) / 2;
    node.y = Math.max(startY, center - node.height / 2);
    cursorY = Math.max(cursorY, node.y + node.height + ROW_GAP);
  };
  layout(placed, 0);

  // ④ Drawing
  const boxes: string[] = [];
  const edges: string[] = [];

  const draw = (node: Placed): void => {
    const nameY = node.y + fontSize + attrSize + 10;
    boxes.push(
      [
        `<g class="cls">`,
        `  <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"/>`,
        `  <text x="${node.x + node.width / 2}" y="${node.y + attrSize + 10}" class="stereo">«${escapeXml(node.stereotype)}»</text>`,
        `  <text x="${node.x + node.width / 2}" y="${nameY}" class="cname">${escapeXml(node.name)}</text>`,
        node.attributes.length > 0
          ? `  <line x1="${node.x}" y1="${node.y + headerHeight}" x2="${node.x + node.width}" y2="${node.y + headerHeight}"/>`
          : '',
        ...node.attributes.map(
          (line, index) =>
            `  <text x="${node.x + 12}" y="${node.y + headerHeight + 6 + (index + 1) * lineHeight - 5}" class="attr">${escapeXml(line)}</text>`,
        ),
        `</g>`,
      ]
        .filter((line) => line !== '')
        .join('\n    '),
    );

    for (const child of node.children) {
      const fromX = node.x + node.width;
      const fromY = node.y + node.height / 2;
      const toX = child.x;
      const toY = child.y + child.height / 2;
      const midX = (fromX + toX) / 2;
      // The composition diamond attaches on the **parent side**
      const d = 6;
      edges.push(
        `<path class="link" d="M ${fromX + d * 2} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}"/>`,
        `<path class="diamond" d="M ${fromX} ${fromY} L ${fromX + d} ${fromY - d} L ${fromX + d * 2} ${fromY} L ${fromX + d} ${fromY + d} Z"/>`,
        `<text class="mult" x="${toX - 8}" y="${toY - 6}" text-anchor="end">${escapeXml(child.multiplicity)}</text>`,
      );
      draw(child);
    }
  };
  draw(placed);

  const contentRight = Math.max(...xByDepth.map((x, depth) => x + (widthByDepth[depth] ?? 0)));
  const width = contentRight + FRAME_PAD + PAD;
  const height = cursorY + FRAME_PAD;

  // Frame and top-left tab — this is the shape of the document's figure
  const tabText = frameLabel;
  const tabWidth = textWidth(tabText, fontSize) + 30;
  const tabHeight = fontSize + 14;
  const frame = [
    `<rect class="frame" x="${PAD}" y="${PAD}" width="${width - PAD * 2}" height="${height - PAD * 2}"/>`,
    `<path class="frame" d="M ${PAD} ${PAD} h ${tabWidth} l 14 ${tabHeight} v 0 h -${tabWidth + 14} Z"/>`,
    `<text class="tab" x="${PAD + 10}" y="${PAD + tabHeight - 4}">${escapeXml(tabText)}</text>`,
  ].join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Malgun Gothic','Apple SD Gothic Neo','Segoe UI',sans-serif">
  <style>
    .bg { fill: #ffffff; }
    .frame { fill: none; stroke: #6d6d6d; stroke-width: 1; }
    .tab { font-size: ${fontSize}px; fill: #1b1b1b; }
    .cls rect { fill: #ffffff; stroke: #1b1b1b; stroke-width: 1.2; }
    .cls line { stroke: #1b1b1b; stroke-width: 1; }
    .stereo { font-size: ${attrSize - 1}px; fill: #555555; text-anchor: middle; }
    .cname { font-size: ${fontSize + 2}px; fill: #111111; text-anchor: middle; }
    .attr { font-size: ${attrSize}px; fill: #1b1b1b; }
    .link { fill: none; stroke: #4a4a4a; stroke-width: 1; }
    .diamond { fill: #4a4a4a; stroke: #4a4a4a; }
    .mult { font-size: ${attrSize - 1}px; fill: #8b1a1a; }
  </style>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}"/>
    ${frame}
    ${edges.join('\n    ')}
    ${boxes.join('\n    ')}
</svg>`;
}

export function submodelUml(submodel: Submodel, options: UmlOptions = {}): string {
  const settings: Required<UmlOptions> = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxAttributes: options.maxAttributes ?? 14,
    fontSize: options.fontSize ?? 13,
    valueLimit: options.valueLimit ?? 18,
  };
  const name = submodel.idShort ?? submodel.id;
  const node = toNode(submodel as unknown as SubmodelElement, 0, settings, name, '0..1');
  // The submodel itself may not have modelType 'Submodel' (varies by file) — the root is always SM
  node.stereotype = 'SM';
  node.name = name;
  return renderUml(node, `SMT ${name}`, settings);
}

/** Overall structure diagram of one AAS — drawn in the same style */
export function overviewUml(environment: Environment, options: UmlOptions = {}): string {
  const settings: Required<UmlOptions> = {
    maxDepth: options.maxDepth ?? 1,
    maxAttributes: options.maxAttributes ?? 20,
    fontSize: options.fontSize ?? 13,
    valueLimit: options.valueLimit ?? 18,
  };
  const shell = environment.assetAdministrationShells?.[0];
  const submodels = environment.submodels ?? [];
  const name = shell?.idShort ?? 'AssetAdministrationShell';

  const root: Node = {
    stereotype: 'AAS',
    name,
    multiplicity: '0..1',
    attributes: submodels.map((submodel) => `+ ${submodel.idShort ?? submodel.id} : SM`),
    children: submodels.map((submodel) => ({
      stereotype: 'SM',
      name: submodel.idShort ?? submodel.id,
      multiplicity: '0..1',
      attributes: (submodel.submodelElements ?? [])
        .slice(0, 6)
        .map((element, index) => attributeLine(element, index, settings.valueLimit)),
      children: [],
    })),
  };
  return renderUml(root, `AAS ${name}`, settings);
}
