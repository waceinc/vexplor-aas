/**
 * Submodel component detail table — a guidance appendix.
 *
 * Basis: KTL regulation §13, caution 5.
 *
 * > Only for submodels that contain equipment-specific elements (TechnicalData–TechnicalPropertyAreas,
 * > OperationalData, and other equipment-specific submodels), write a **'submodel component detail table'**
 * > so that the example data and structure can be clearly confirmed.
 * >
 * > For IDTA standard submodel templates that contain no equipment-specific elements, **omit the existing
 * > SMC and property tables** and instead give information about the reference model (UML Diagram, external
 * > reference model name, reference dictionary, features of the submodel and its main components, how the
 * > submodel is used, template download link, etc.)
 *
 * Important: so this module does two things: **build the table, and say so when one should not be built**.
 *    If the tool produced tables even for standard-template submodels, it would be encouraging exactly
 *    what the regulation says to "omit".
 *
 * Important: the tool fills in **only what it can read from the file**. Things like usage scenarios and features
 *    are written by people. Unknown cells are left blank and marked as "for a person to fill in" — nothing is
 *    made up to look plausible.
 */
import { csvCell } from '../csv.js';
import { fill, tr, type ConceptDescription, type Environment, type Submodel, type SubmodelElement } from '@aas/core';
import { isStandardTerm } from '../policy.js';
import { iec61360Of } from '../util.js';

const CONTAINER_TYPES = new Set([
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
  'AnnotatedRelationshipElement',
]);

/** Standard dictionary IRDI prefix — an element using it is a standard-template element */
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
  /** Why it was judged that way — shown on screen as-is */
  reason: string;
  /** Number of equipment-specific elements */
  specificCount: number;
}

/**
 * Whether this submodel gets a table.
 *
 * Regulation §13, caution 5: write the table **"only for submodels that contain equipment-specific elements"**;
 * IDTA standard-template submodels without equipment-specific elements **omit the table**.
 *
 * Important: "equipment-specific" is judged by **semanticId**, not by name. Verified against the table layout of
 * an actual submitted guidance document (01-Roll Forming Machine V4.0) —
 * DigitalNameplate and HandoverDocumentation, which have 0 own-IRI elements, have no table,
 * and the other 5 submodels, which have their own IRIs, do. Filtering by a list of names would disagree with
 * that document (HierarchicalStructures and MaintenanceInstructions are IDTA standards but do have tables).
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
      reason: fill(tr('장비 특화 요소 {0}개를 담고 있습니다(자체 IRI semanticId).'), { 0: specificCount }),
    };
  }
  return {
    idShort,
    kind: 'info',
    specificCount: 0,
    reason:
      tr('장비 특화 요소가 없는 IDTA 표준 템플릿입니다 — 규정 §13 주의사항 5에 따라 표는 생략합니다.'),
  };
}

export interface TableRow {
  /** Hierarchy depth — shown as indentation in the table */
  depth: number;
  path: string;
  idShort: string;
  modelType: string;
  dataType: string;
  unit: string;
  /** Example value — the regulation requires "example data clearly shown" */
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
 * Builds the table.
 * Units and descriptions **come from the ConceptDescription** — that is where definitions live (they are not on
 * the element).
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
        // Container elements (SMC, SML, Entity) have no data type.
        // Using the concept definition's dataType (STRING etc.) as-is reads like "holds a string" and is misleading
        dataType: CONTAINER_TYPES.has(node.modelType)
          ? ''
          : String(raw['valueType'] ?? spec?.dataType ?? '').replace(/^xs:/, ''),
        unit: spec?.unit ?? '',
        example: exampleOf(node),
        semanticId,
        // Use the element description if present, otherwise the concept description (CD) definition
        description: langText(raw['description'] as never) || langText(spec?.definition as never),
      });

      walk(childrenOf(node), depth + 1, path);
    });
  };
  walk(submodel.submodelElements ?? [], 0, '');
  return rows;
}

/** Table headers — the language differs per request, so translate at call time */
const columns = (): readonly string[] => [
  tr('구분'),
  'idShort',
  tr('종류'),
  tr('데이터타입'),
  tr('단위'),
  tr('예시 값'),
  'semanticId',
  tr('설명'),
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds HTML so it pastes into Word / Hangul **as an actual table**.
 * Pasting only text and pasting a table are entirely different things in practice.
 */
export function tableHtml(rows: readonly TableRow[]): string {
  const head = columns().map((column) => `<th>${column}</th>`).join('');
  const body = rows
    .map((row) => {
      // Hierarchy is shown by indentation — putting the full path in would overflow the cell
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

/** So it opens in Excel. Important: adds a BOM — without it Excel garbles Korean text */
export function tableCsv(rows: readonly TableRow[]): string {
  const escape = (value: string): string => csvCell(value, 'always');
  const lines = [columns().map(escape).join(',')];
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

/** Information to give instead, for submodels whose table is omitted (regulation §13, caution 5) */
export interface SubmodelInfo {
  idShort: string;
  /** External reference model name — the standard template the semanticId points to */
  externalTemplate: string;
  /** Reference dictionary — determined from the semanticId prefix */
  dictionaries: string[];
  /** Link to the original template (caution 2) — left blank if it cannot be known from the file */
  templateLink: string;
  elementCount: number;
  /** Items a person must fill in */
  toWrite: string[];
}

/** Determines which dictionary was used from the start of the semanticId (caution 1: its version must be stated) */
function dictionaryOf(semanticId: string): string | undefined {
  if (semanticId.startsWith('0173-')) return 'ECLASS (IRDI)';
  if (semanticId.startsWith('0112/')) return 'IEC CDD (IRDI)';
  if (isStandardTerm(semanticId)) return tr('IDTA 표준 템플릿 용어');
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
    // Important: do not make things up. A person checks the IDTA Content Hub and enters the original template link
    templateLink: '',
    elementCount,
    toWrite: [
      tr('용어사전 버전 (주의사항 1 — 파일에는 IRDI만 있고 사전 버전은 없습니다)'),
      tr('템플릿 원본 링크 (주의사항 2 — IDTA Content Hub에서 최신 버전 확인)'),
      tr('서브모델 및 주요 구성요소 특징'),
      tr('서브모델 활용방안'),
      tr('활용 시나리오 (주의사항 4)'),
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * IDTA SMT table — the format used by actual submitted guidance documents
 *
 * Important: the layout is based on the tables (10–59) in the AAS usage guidance document.
 *    Each container element (Submodel, SMC, SML, Entity) gets one table: the first 5 rows have 2 columns
 *    (label | value), followed by a 4-column list of children.
 *
 *      idShort:     | ConditionStatus
 *      Class:       | SubmodelElementCollection
 *      semanticId:  | [IRI] https://…  ⏎ Condition Status ⏎ 설비 상태 그룹
 *      Parent:      | SMC "MaintenanceMonitoring"
 *      Explanation: | Condition Status
 *      [SME type]idShort | semanticId = [idType]value ⏎ Description@en | [valueType]example | card.
 *      [Prop]RollWearStatus | [IRI] … | [string]Normal | 0..1
 * ──────────────────────────────────────────────────────────────────────────── */

/** Element-kind abbreviation used in the document */
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
  /** `[IRI]` or `[IRDI]` */
  idType: string;
  id: string;
  /** Meaning from the concept description (en) */
  definition: string;
  /** Korean description */
  korean: string;
  /** IDTA original that the own IRI points to (supplementalSemanticIds) */
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

/** Value cell — leaves show `[type]value`, containers show `[-]N elements` */
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
  // The document also notes, for an Entity, whether it is self-managed
  if (node.modelType === 'Entity') {
    const kind = (node as unknown as Record<string, unknown>)['entityType'];
    return `[${abbreviation}]${name}${kind ? `(${String(kind)})` : ''}`;
  }
  return `[${abbreviation}]${name}${node.idShort === undefined ? `_${index}` : ''}`;
}

/**
 * Extracts all tables from one submodel — one per container element.
 * Order matches the document: **top to bottom (depth-first)**.
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
        // Important: list children are 0..* — a slot where several items come by position
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
  if (cell.idtaOrigin !== '') lines.push(fill(tr('IDTA 원본: {0}'), { 0: escapeHtml(cell.idtaOrigin) }));
  return lines.join('<br/>');
}

/**
 * Table caption.
 * Important: exactly the form actual guidance documents use — `표 5 TechnicalData - GeneralInformation`.
 *    In the document it goes **above the table** (figure captions go below figures).
 */
export function smtTableCaption(number: number, submodelName: string, table: SmtTable): string {
  return fill(tr('표 {0} {1} - {2}'), { 0: number, 1: submodelName, 2: table.idShort });
}

/** A table that pastes into the document as-is. Built as HTML so Word / Hangul accept it as a table */
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
  /** Starting table number — must continue across the whole document */
  from?: number;
  /** Submodel name to put in the caption */
  submodelName?: string;
}

/**
 * Tables as HTML for pasting into a document.
 * Important: **give each table a caption and space them apart** — run together, you cannot tell where one table ends.
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
