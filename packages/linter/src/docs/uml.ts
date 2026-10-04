/**
 * 서브모델 UML 클래스 다이어그램 (SVG).
 *
 * 근거: KTL 규정 §13 주의사항 3 — **모든 서브모델에 UML Diagram 첨부**.
 * 🔴 모양은 실제 제출 가이던스(01-롤포밍기 V4.0 · [별첨1] 기계식 프레스 V2.0)의
 *    「그림 14~20 서브모델 UML 다이어그램」을 그대로 따랐다. 내 취향으로 그리면
 *    문서 안에서 앞뒤 그림과 따로 논다.
 *
 * 그 그림의 규칙:
 *  ① 바깥에 프레임을 두르고 왼쪽 위 탭에 `SMT <서브모델명>`
 *  ② 클래스 상자 = «스테레오타입»(SM·SMC·SML) + 이름 + 구분선 + **속성 칸**
 *  ③ 속성 한 줄 = `+ 이름 : 타입 = "값"` — 잎(Property·MLP)은 값까지, 담는 것은 타입만
 *  ④ **담는 요소만 자기 상자를 갖는다.** 잎은 부모 상자의 속성 줄로만 나온다
 *  ⑤ 왼쪽에서 오른쪽으로 흐르고, 합성(◆)으로 잇는다. 자식 쪽에 다중도(0..1 · 1..*)
 *  ⑥ 흰 바탕·검정 선. 문서는 흰 종이다
 *
 * 라이브러리를 쓰지 않고 SVG를 직접 쓴다 — 상자와 선뿐이라 의존성을 늘릴 이유가 없다.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';

export interface UmlOptions {
  /**
   * 몇 단계까지 상자로 펼칠지. 기본 {@link DEFAULT_MAX_DEPTH}.
   *
   * 🔴 예전 기본값 3은 **실제 파일을 잘랐다**(2026-09-21 실측). 골든 파일 7종 중 3종이
   *    안쪽을 잃었다 — HandoverDocumentation 6→10 · TechnicalData 8→14 ·
   *    MaintenanceInstructions 12→15 상자. 특히 TechnicalData는 `RollGeometry : SMC`처럼
   *    껍데기만 남고 **실제 사양 값이 한 개도 나오지 않았다**. 장비 특화 서브모델이라
   *    가이던스에서 값이 보여야 하는 바로 그 그림이었다.
   */
  maxDepth?: number;
  /** 한 상자에 담을 속성 줄 수. 넘치면 「… 그 밖 N개」 */
  maxAttributes?: number;
  /** 기본 글자 크기(px) */
  fontSize?: number;
  /** 속성 줄의 값 길이 상한 */
  valueLimit?: number;
}

/**
 * 상자로 펼치는 기본 깊이.
 *
 * 담는 요소를 **끝까지** 펼치는 것이 옳지만 상한은 남긴다 — 기형적으로 깊은 파일에서
 * 그림이 무한히 넓어지면 A4 축소 배율이 떨어져 글자가 뭉갠다.
 * 실측 최대는 5단계(HandoverDocumentation)라 8이면 여유가 있다.
 */
const DEFAULT_MAX_DEPTH = 8;

/** 담는 요소만 상자를 갖는다 */
const CONTAINERS = new Set([
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
  'AnnotatedRelationshipElement',
]);

/** 실제 문서가 쓰는 약칭 */
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
   * 이 상자로 들어오는 선에 붙는 다중도.
   * 🔴 **부모**가 무엇인지로 정해진다 — 리스트(SML)의 자식이면 `1..*`, 그 밖은 `0..1`.
   *    문서의 그림이 그렇다: `SM ◆—0..1— Markings(SML) ◆—1..*— Marking(SMC)`
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
  // 뿌리(서브모델)는 자식을 다른 이름으로 담는다
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

/** 속성 줄의 값 — 문서는 `= "값"` 꼴로 적는다 */
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

/** 속성 줄 하나 — `+ 이름 : 타입 = "값"` */
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
 * SubmodelElementList의 자식은 전부 같은 꼴이라 **대표 하나만** 그린다(문서도 그렇게 한다).
 * 이름은 `MarkingsEntry_0` 같은 색인 꼬리를 떼고, 목록 이름과 같아지면 복수형 s를 뗀다.
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
  // 리스트 자식은 전부 같은 꼴이라 대표 하나만 그린다(문서도 그렇게 한다)
  const shown = isList ? kids.slice(0, 1) : kids;
  /** 리스트 자식은 색인 꼬리를 뗀 이름으로 부른다 — `MarkingsEntry_0` → `Marking` */
  const nameOf = (child: SubmodelElement, index: number): string =>
    isList ? listItemName(element.idShort ?? '', child, index) : (child.idShort ?? `[${index}]`);

  const attributes = shown
    .slice(0, options.maxAttributes)
    .map((child, index) => attributeLine(child, index, options.valueLimit, nameOf(child, index)));
  if (shown.length > options.maxAttributes) {
    attributes.push(`… 그 밖 ${shown.length - options.maxAttributes}개`);
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
        // 🔴 리스트의 자식이면 1..* — 다중도는 부모가 정한다
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

  // ① 상자 크기
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

  // ② 열 x 좌표 — 깊이마다 가장 넓은 상자에 맞춘다
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

  // ③ y 좌표 — 자식 묶음의 한가운데에 부모를 둔다
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

  // ④ 그리기
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
      // 합성 마름모는 **부모 쪽**에 붙는다
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

  // 프레임과 왼쪽 위 탭 — 문서의 그림이 이 모양이다
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
  // 서브모델 자신은 modelType이 'Submodel'이 아닐 수 있다(파일마다 다르다) — 뿌리는 항상 SM이다
  node.stereotype = 'SM';
  node.name = name;
  return renderUml(node, `SMT ${name}`, settings);
}

/** AAS 한 대의 전체 구성도 — 같은 모양으로 그린다 */
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
