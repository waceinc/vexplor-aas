/**
 * 서브모델 구성요소 상세 정보 테이블 — 가이던스 부속물.
 *
 * 근거: KTL 규정 §13 주의사항 5.
 *
 * > 장비 특화 요소를 포함하는 서브모델에 한하여(TechnicalData–TechnicalPropertyAreas,
 * > OperationalData, 그 외 장비특화 서브모델) **'서브모델 구성요소 상세 정보 테이블'** 을 작성하여
 * > 예시 데이터와 구조를 명확하게 확인할 수 있도록 함.
 * >
 * > 장비 특화 요소를 포함하지 않는 IDTA 표준 서브모델 템플릿에 포함된 **기존 SMC 및 프로퍼티 표는
 * > 생략**하고 해당 참조모델에 관한 정보(UML Diagram, 외부 참조모델명, 참조 용어사전,
 * > 서브모델 및 주요 구성요소 특징, 서브모델 활용방안, 템플릿 다운로드 링크 등)를 기재
 *
 * 🔴 그래서 이 모듈이 하는 일은 **표를 만드는 것과, 만들지 말아야 할 때 그렇게 말하는 것** 둘이다.
 *    표준 템플릿 서브모델에까지 표를 뽑아 주면 규정이 "생략하라"고 한 것을 도구가 부추기게 된다.
 *
 * 🔴 도구는 파일에서 **읽을 수 있는 것만** 채운다. 활용 시나리오·특징 같은 것은 사람이 쓴다.
 *    모르는 칸은 비워 두고 「사람이 채울 자리」로 표시한다 — 그럴듯하게 지어내지 않는다.
 */
import type { ConceptDescription, Environment, Submodel, SubmodelElement } from '@aas/core';
import { isStandardTerm } from '../policy.js';
import { iec61360Of } from '../util.js';

const CONTAINER_TYPES = new Set([
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
  'AnnotatedRelationshipElement',
]);

/** 표준 사전 IRDI 접두사 — 이걸 쓰면 표준 템플릿 요소다 */
const IRDI_PREFIXES = ['0173-', '0112/'];

function isEquipmentSpecific(semanticId: string | undefined): boolean {
  if (!semanticId) return false;
  if (IRDI_PREFIXES.some((prefix) => semanticId.startsWith(prefix))) return false;
  return !isStandardTerm(semanticId);
}

export type SubmodelDocKind = 'table' | 'info';

export interface SubmodelDocPlan {
  idShort: string;
  kind: SubmodelDocKind;
  /** 왜 그렇게 판정했는지 — 화면에 그대로 보여 준다 */
  reason: string;
  /** 장비 특화 요소 수 */
  specificCount: number;
}

/**
 * 표를 만들 서브모델인가.
 *
 * 규정 §13 주의사항 5: **"장비 특화 요소를 포함하는 서브모델에 한하여"** 표를 작성하고,
 * 장비 특화 요소가 없는 IDTA 표준 템플릿 서브모델은 **표를 생략**한다.
 *
 * 🔴 "장비 특화"의 판정은 이름이 아니라 **semanticId**로 한다. 실제 제출 가이던스
 * (01-롤포밍기 V4.0)의 표 구성과 대조해 확인했다 —
 * 자체 IRI 요소가 0인 DigitalNameplate·HandoverDocumentation에는 표가 없고,
 * 자체 IRI를 가진 나머지 5종에는 표가 있다. 이름 목록으로 가리면 그 문서와 어긋난다
 * (HierarchicalStructures·MaintenanceInstructions는 IDTA 표준이지만 표가 있다).
 */
export function planFor(submodel: Submodel): SubmodelDocPlan {
  const idShort = submodel.idShort ?? submodel.id;
  let specificCount = 0;
  const walk = (nodes: readonly SubmodelElement[]): void => {
    for (const node of nodes) {
      if (isEquipmentSpecific(node.semanticId?.keys?.[0]?.value)) specificCount += 1;
      walk(childrenOf(node));
    }
  };
  walk(submodel.submodelElements ?? []);

  if (specificCount > 0) {
    return {
      idShort,
      kind: 'table',
      specificCount,
      reason: `장비 특화 요소 ${specificCount}개를 담고 있습니다(자체 IRI semanticId).`,
    };
  }
  return {
    idShort,
    kind: 'info',
    specificCount: 0,
    reason:
      '장비 특화 요소가 없는 IDTA 표준 템플릿입니다 — 규정 §13 주의사항 5에 따라 표는 생략합니다.',
  };
}

export interface TableRow {
  /** 계층 깊이 — 표에서 들여쓰기로 보여 준다 */
  depth: number;
  path: string;
  idShort: string;
  modelType: string;
  dataType: string;
  unit: string;
  /** 예시 값 — 규정이 "예시 데이터를 명확히"라고 요구한다 */
  example: string;
  semanticId: string;
  description: string;
}

function langText(strings: { language: string; text: string }[] | undefined): string {
  if (!strings || strings.length === 0) return '';
  const korean = strings.find((entry) => entry.language.toLowerCase().startsWith('ko'));
  const english = strings.find((entry) => entry.language.toLowerCase().startsWith('en'));
  return (korean ?? english ?? strings[0]!).text;
}

function exampleOf(node: SubmodelElement): string {
  const raw = node as unknown as Record<string, unknown>;
  if (node.modelType === 'MultiLanguageProperty') {
    return langText(raw['value'] as { language: string; text: string }[] | undefined);
  }
  if (node.modelType === 'Range') {
    return `${String(raw['min'] ?? '')} ~ ${String(raw['max'] ?? '')}`;
  }
  if (typeof raw['value'] === 'string') return raw['value'];
  return '';
}

function childrenOf(node: SubmodelElement): SubmodelElement[] {
  const raw = node as unknown as Record<string, unknown>;
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(raw['value']) ? (raw['value'] as SubmodelElement[]) : [];
  }
  if (node.modelType === 'Entity') {
    return Array.isArray(raw['statements']) ? (raw['statements'] as SubmodelElement[]) : [];
  }
  return [];
}

/**
 * 표를 만든다.
 * 단위·설명은 **ConceptDescription에서 가져온다** — 거기가 정의의 자리다(요소에 적혀 있지 않다).
 */
export function submodelTable(environment: Environment, submodel: Submodel): TableRow[] {
  const concepts = new Map<string, ConceptDescription>();
  for (const cd of environment.conceptDescriptions ?? []) concepts.set(cd.id, cd);

  const rows: TableRow[] = [];
  const walk = (nodes: readonly SubmodelElement[], depth: number, parentPath: string): void => {
    nodes.forEach((node, index) => {
      const idShort = node.idShort ?? `[${index}]`;
      const path = parentPath === '' ? idShort : `${parentPath}.${idShort}`;
      const raw = node as unknown as Record<string, unknown>;
      const semanticId = node.semanticId?.keys?.[0]?.value ?? '';
      const cd = semanticId === '' ? undefined : concepts.get(semanticId);
      const spec = cd ? iec61360Of(cd) : undefined;

      rows.push({
        depth,
        path,
        idShort,
        modelType: node.modelType,
        // 담는 요소(SMC·SML·Entity)에는 데이터타입이 없다.
        // 개념정의의 dataType(STRING 등)을 그대로 쓰면 "문자열을 담는다"처럼 읽혀 오해를 부른다
        dataType: CONTAINER_TYPES.has(node.modelType)
          ? ''
          : String(raw['valueType'] ?? spec?.dataType ?? '').replace(/^xs:/, ''),
        unit: spec?.unit ?? '',
        example: exampleOf(node),
        semanticId,
        // 요소 설명이 있으면 그것을, 없으면 개념정의(CD)의 정의를 쓴다
        description: langText(raw['description'] as never) || langText(spec?.definition as never),
      });

      walk(childrenOf(node), depth + 1, path);
    });
  };
  walk(submodel.submodelElements ?? [], 0, '');
  return rows;
}

const COLUMNS = [
  '구분',
  'idShort',
  '종류',
  '데이터타입',
  '단위',
  '예시 값',
  'semanticId',
  '설명',
] as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 워드·한글에 **표 모양 그대로** 붙도록 HTML로 만든다.
 * 글자만 붙는 것과 표가 붙는 것은 실무에서 전혀 다른 일이다.
 */
export function tableHtml(rows: readonly TableRow[]): string {
  const head = COLUMNS.map((column) => `<th>${column}</th>`).join('');
  const body = rows
    .map((row) => {
      // 계층은 들여쓰기로 보인다 — 경로를 그대로 넣으면 칸이 넘친다
      const indent = '&nbsp;'.repeat(row.depth * 3);
      const cells = [
        `${indent}${row.depth === 0 ? '' : '└ '}`,
        escapeHtml(row.idShort),
        escapeHtml(row.modelType),
        escapeHtml(row.dataType),
        escapeHtml(row.unit),
        escapeHtml(row.example),
        escapeHtml(row.semanticId),
        escapeHtml(row.description),
      ];
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
    })
    .join('\n');

  return `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:'Malgun Gothic',sans-serif;font-size:10pt">
<thead><tr style="background:#eef2f7">${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

/** 엑셀에서 열 수 있게. 🔴 BOM을 붙인다 — 없으면 엑셀이 한글을 깨뜨린다 */
export function tableCsv(rows: readonly TableRow[]): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const lines = [COLUMNS.map(escape).join(',')];
  for (const row of rows) {
    lines.push(
      [
        '  '.repeat(row.depth) + (row.depth === 0 ? '' : '└ '),
        row.idShort,
        row.modelType,
        row.dataType,
        row.unit,
        row.example,
        row.semanticId,
        row.description,
      ]
        .map(escape)
        .join(','),
    );
  }
  return `﻿${lines.join('\r\n')}`;
}

/** 표를 생략하는 서브모델에 대신 기재할 정보 (규정 §13 주의사항 5) */
export interface SubmodelInfo {
  idShort: string;
  /** 외부 참조모델명 — semanticId가 가리키는 표준 템플릿 */
  externalTemplate: string;
  /** 참조 용어사전 — semanticId 접두사로 판별한다 */
  dictionaries: string[];
  /** 템플릿 원본 링크 (주의사항 2) — 파일에서 알 수 없으면 비운다 */
  templateLink: string;
  elementCount: number;
  /** 사람이 채워야 하는 항목 */
  toWrite: string[];
}

/** semanticId 앞자리로 어떤 용어사전을 썼는지 가린다(주의사항 1: 버전 명시 대상) */
function dictionaryOf(semanticId: string): string | undefined {
  if (semanticId.startsWith('0173-')) return 'ECLASS (IRDI)';
  if (semanticId.startsWith('0112/')) return 'IEC CDD (IRDI)';
  if (isStandardTerm(semanticId)) return 'IDTA 표준 템플릿 용어';
  return undefined;
}

export function submodelInfo(submodel: Submodel): SubmodelInfo {
  const semantic = submodel.semanticId?.keys?.[0]?.value ?? '';
  const dictionaries = new Set<string>();

  const walk = (nodes: readonly SubmodelElement[]): number => {
    let count = 0;
    for (const node of nodes) {
      count += 1;
      const id = node.semanticId?.keys?.[0]?.value;
      const dictionary = id ? dictionaryOf(id) : undefined;
      if (dictionary) dictionaries.add(dictionary);
      count += walk(childrenOf(node));
    }
    return count;
  };
  const elementCount = walk(submodel.submodelElements ?? []);

  return {
    idShort: submodel.idShort ?? submodel.id,
    externalTemplate: isStandardTerm(semantic) ? semantic : '',
    dictionaries: [...dictionaries],
    // 🔴 지어내지 않는다. 템플릿 원본 링크는 IDTA Content Hub에서 사람이 확인해 넣는다
    templateLink: '',
    elementCount,
    toWrite: [
      '용어사전 버전 (주의사항 1 — 파일에는 IRDI만 있고 사전 버전은 없습니다)',
      '템플릿 원본 링크 (주의사항 2 — IDTA Content Hub에서 최신 버전 확인)',
      '서브모델 및 주요 구성요소 특징',
      '서브모델 활용방안',
      '활용 시나리오 (주의사항 4)',
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * IDTA SMT 표 — 실제 제출 가이던스가 쓰는 서식
 *
 * 🔴 모양의 근거는 AAS 활용 가이던스 문서의 표(10~59)다.
 *    담는 요소(Submodel·SMC·SML·Entity)마다 표가 하나씩 붙고, 앞 5줄은 2칸(라벨|값),
 *    그 뒤로 4칸짜리 자식 목록이 온다.
 *
 *      idShort:     | ConditionStatus
 *      Class:       | SubmodelElementCollection
 *      semanticId:  | [IRI] https://…  ⏎ Condition Status ⏎ 설비 상태 그룹
 *      Parent:      | SMC "MaintenanceMonitoring"
 *      Explanation: | Condition Status
 *      [SME type]idShort | semanticId = [idType]value ⏎ Description@en | [valueType]example | card.
 *      [Prop]RollWearStatus | [IRI] … | [string]Normal | 0..1
 * ──────────────────────────────────────────────────────────────────────────── */

/** 문서가 쓰는 종류 약칭 */
const TYPE_ABBREVIATION: Record<string, string> = {
  Property: 'Prop',
  MultiLanguageProperty: 'MLP',
  Range: 'Range',
  File: 'File',
  Blob: 'Blob',
  ReferenceElement: 'Ref',
  RelationshipElement: 'Rel',
  AnnotatedRelationshipElement: 'ARel',
  SubmodelElementCollection: 'SMC',
  SubmodelElementList: 'SML',
  Entity: 'Ent',
  Capability: 'Cap',
  Operation: 'Opr',
  BasicEventElement: 'Event',
  Submodel: 'SM',
};

export interface SemanticCell {
  /** `[IRI]` 또는 `[IRDI]` */
  idType: string;
  id: string;
  /** 개념정의의 뜻 (en) */
  definition: string;
  /** 우리말 설명 */
  korean: string;
  /** 자체 IRI가 가리키는 IDTA 원본 (supplementalSemanticIds) */
  idtaOrigin: string;
}

export interface SmtChildRow {
  /** `[Prop]RollWearStatus` */
  label: string;
  semantic: SemanticCell;
  /** `[string]Normal` · `[-]2 elements` */
  value: string;
  cardinality: string;
}

export interface SmtTable {
  idShort: string;
  className: string;
  semantic: SemanticCell;
  /** `SM "OperationalData"` · `-` */
  parent: string;
  explanation: string;
  children: SmtChildRow[];
}

function semanticCell(
  node: { semanticId?: { keys?: { value: string }[] }; supplementalSemanticIds?: unknown },
  concepts: Map<string, ConceptDescription>,
): SemanticCell {
  const id = node.semanticId?.keys?.[0]?.value ?? '';
  const idType = id === '' ? '' : IRDI_PREFIXES.some((p) => id.startsWith(p)) ? '[IRDI]' : '[IRI]';
  const cd = concepts.get(id);
  const spec = cd ? iec61360Of(cd) : undefined;
  const supplemental = node.supplementalSemanticIds as
    | { keys?: { value: string }[] }[]
    | undefined;

  const definitions = (spec?.definition ?? []) as { language: string; text: string }[];
  const english = definitions.find((entry) => entry.language.toLowerCase().startsWith('en'));
  const korean = definitions.find((entry) => entry.language.toLowerCase().startsWith('ko'));
  const descriptions = (cd?.description ?? []) as { language: string; text: string }[];
  const koreanDescription = descriptions.find((entry) =>
    entry.language.toLowerCase().startsWith('ko'),
  );

  return {
    idType,
    id,
    definition: english?.text ?? langText(spec?.preferredName as never) ?? '',
    korean: korean?.text ?? koreanDescription?.text ?? '',
    idtaOrigin: supplemental?.[0]?.keys?.[0]?.value ?? '',
  };
}

/** 값 칸 — 잎은 `[타입]값`, 담는 것은 `[-]N elements` */
function valueCell(node: SubmodelElement): string {
  const record = node as unknown as Record<string, unknown>;
  if (CONTAINER_TYPES.has(node.modelType)) {
    return `[-]${childrenOf(node).length} elements`;
  }
  if (node.modelType === 'MultiLanguageProperty') {
    return `[langString]${langText(record['value'] as never)}`;
  }
  if (node.modelType === 'Range') {
    const type = String(record['valueType'] ?? '').replace(/^xs:/, '');
    return `[${type}]${String(record['min'] ?? '')} ~ ${String(record['max'] ?? '')}`;
  }
  if (node.modelType === 'RelationshipElement') {
    const reference = (target: unknown): string => {
      const keys = (target as { keys?: { type: string; value: string }[] } | undefined)?.keys ?? [];
      return keys.map((key) => `[${key.type}, ${key.value}]`).join(',');
    };
    return `[Reference]${reference(record['first'])} -> ${reference(record['second'])}`;
  }
  if (node.modelType === 'ReferenceElement') {
    const keys = (record['value'] as { keys?: { type: string; value: string }[] } | undefined)?.keys ?? [];
    return `[Reference]${keys.map((key) => `[${key.type}, ${key.value}]`).join(',')}`;
  }
  const type = String(record['valueType'] ?? '').replace(/^xs:/, '');
  const value = typeof record['value'] === 'string' ? record['value'] : '';
  return `[${type || '-'}]${value}`;
}

function childLabel(node: SubmodelElement, index: number): string {
  const abbreviation = TYPE_ABBREVIATION[node.modelType] ?? node.modelType;
  const name = node.idShort ?? '(anon)';
  // 문서는 Entity에 자기관리 여부를 함께 적는다
  if (node.modelType === 'Entity') {
    const kind = (node as unknown as Record<string, unknown>)['entityType'];
    return `[${abbreviation}]${name}${kind ? `(${String(kind)})` : ''}`;
  }
  return `[${abbreviation}]${name}${node.idShort === undefined ? `_${index}` : ''}`;
}

/**
 * 서브모델 하나에서 표를 전부 뽑는다 — 담는 요소마다 한 장.
 * 순서는 문서와 같게 **위에서 아래로(깊이 우선)**.
 */
export function submodelTables(environment: Environment, submodel: Submodel): SmtTable[] {
  const concepts = new Map<string, ConceptDescription>();
  for (const cd of environment.conceptDescriptions ?? []) concepts.set(cd.id, cd);

  const tables: SmtTable[] = [];

  const build = (
    node: { idShort?: string; modelType?: string; semanticId?: unknown },
    children: readonly SubmodelElement[],
    parent: string,
    isList: boolean,
  ): void => {
    const semantic = semanticCell(node as never, concepts);
    tables.push({
      idShort: node.idShort ?? '(anon)',
      className: node.modelType ?? 'Submodel',
      semantic,
      parent,
      explanation: semantic.definition || '-',
      children: children.map((child, index) => ({
        label: childLabel(child, index),
        semantic: semanticCell(child as never, concepts),
        value: valueCell(child),
        // 🔴 리스트의 자식은 0..* — 순서로 여러 개가 오는 자리다
        cardinality: isList ? '0..*' : '0..1',
      })),
    });

    const own = `${TYPE_ABBREVIATION[node.modelType ?? 'Submodel'] ?? ''} "${node.idShort ?? '(anon)'}"`;
    for (const child of children) {
      const kids = childrenOf(child);
      if (CONTAINER_TYPES.has(child.modelType) && kids.length > 0) {
        build(child, kids, own, child.modelType === 'SubmodelElementList');
      }
    }
  };

  build(
    { idShort: submodel.idShort ?? submodel.id, modelType: 'Submodel', semanticId: submodel.semanticId },
    submodel.submodelElements ?? [],
    '-',
    false,
  );
  return tables;
}

function semanticHtml(cell: SemanticCell): string {
  if (cell.id === '') return '-';
  const lines = [`${cell.idType} ${escapeHtml(cell.id)}`];
  if (cell.definition !== '') lines.push(escapeHtml(cell.definition));
  if (cell.korean !== '') lines.push(escapeHtml(cell.korean));
  if (cell.idtaOrigin !== '') lines.push(`IDTA 원본: ${escapeHtml(cell.idtaOrigin)}`);
  return lines.join('<br/>');
}

/**
 * 표 제목.
 * 🔴 실제 가이던스가 쓰는 꼴 그대로다 — `표 5 TechnicalData - GeneralInformation`.
 *    문서에서 **표 위에** 온다(그림 제목은 그림 아래).
 */
export function smtTableCaption(number: number, submodelName: string, table: SmtTable): string {
  return `표 ${number} ${submodelName} - ${table.idShort}`;
}

/** 문서에 그대로 붙는 표. 워드·한글이 표로 받아들이도록 HTML로 만든다 */
export function smtTableHtml(table: SmtTable): string {
  const label = (text: string): string =>
    `<td style="background:#DAE9F7;font-weight:bold;width:22%">${text}</td>`;
  const head = ['[SME type]idShort', 'semanticId = [idType]value<br/>Description@en', '[valueType]example', 'card.']
    .map((text) => `<td style="background:#DAE9F7;font-weight:bold">${text}</td>`)
    .join('');

  const rows = table.children
    .map(
      (child) =>
        `<tr><td>${escapeHtml(child.label)}</td><td>${semanticHtml(child.semantic)}</td>` +
        `<td>${escapeHtml(child.value)}</td><td>${escapeHtml(child.cardinality)}</td></tr>`,
    )
    .join('\n');

  return `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:'Malgun Gothic',sans-serif;font-size:9pt;width:100%">
<tr>${label('idShort:')}<td colspan="3">${escapeHtml(table.idShort)}</td></tr>
<tr>${label('Class:')}<td colspan="3">${escapeHtml(table.className)}</td></tr>
<tr>${label('semanticId:')}<td colspan="3">${semanticHtml(table.semantic)}</td></tr>
<tr>${label('Parent:')}<td colspan="3">${escapeHtml(table.parent)}</td></tr>
<tr>${label('Explanation:')}<td colspan="3">${escapeHtml(table.explanation)}</td></tr>
<tr>${head}</tr>
${rows}
</table>`;
}

export interface TablesHtmlOptions {
  /** 표 번호 시작값 — 문서 전체에서 이어져야 한다 */
  from?: number;
  /** 제목에 들어갈 서브모델 이름 */
  submodelName?: string;
}

/**
 * 표들을 문서에 붙일 HTML로.
 * 🔴 표마다 **제목을 달고 사이를 띄운다** — 붙여 놓으면 어디까지가 한 표인지 알 수 없다.
 */
export function submodelTablesHtml(
  tables: readonly SmtTable[],
  options: TablesHtmlOptions = {},
): string {
  const from = options.from ?? 1;
  const name = options.submodelName ?? tables[0]?.idShort ?? '';
  return tables
    .map((table, index) => {
      const caption = smtTableCaption(from + index, name, table);
      return (
        `<p style="margin:14pt 0 4pt;font-weight:bold;font-size:10pt">${escapeHtml(caption)}</p>\n` +
        smtTableHtml(table)
      );
    })
    .join('\n<p style="margin:0;font-size:6pt">&nbsp;</p>\n');
}
