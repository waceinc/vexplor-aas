/**
 * idShortPath resolution and ValueOnly serialization.
 *
 * IDTA Part 2 addresses a SubmodelElement by an **idShortPath** such as `Markings.MarkingsEntry[0].Name`.
 * A dot (.) is a hierarchy level; square brackets are a SubmodelElementList index.
 * The traversal rules must match traverse in @aas/core — if the location the linter reports and the location the API points to
 * diverge, the authoring UI cannot open "the element that was flagged".
 */
import type { LangString, Submodel, SubmodelElement } from '@aas/core';
import { fill, tr } from '@aas/core';

export interface ElementLocation {
  /** Array that contains node */
  list: SubmodelElement[];
  /** Position within list */
  index: number;
  node: SubmodelElement;
}

/** Fields holding children — same rules as childrenOf in traverse.ts */
function childrenOf(node: SubmodelElement): SubmodelElement[] | undefined {
  switch (node.modelType) {
    case 'SubmodelElementCollection':
    case 'SubmodelElementList':
      return node.value;
    case 'Entity':
      return node.statements;
    case 'AnnotatedRelationshipElement':
      return node.annotations;
    default:
      return undefined;
  }
}

const SEGMENT = /^([^[\]]*)((?:\[\d+\])*)$/;

export function resolveIdShortPath(
  submodel: Submodel,
  path: string,
): ElementLocation | undefined {
  let list: SubmodelElement[] | undefined = submodel.submodelElements ?? [];
  let location: ElementLocation | undefined;

  for (const segment of path.split('.')) {
    if (!list) return undefined;
    const match = SEGMENT.exec(segment);
    if (!match) return undefined;
    const [, name = '', brackets = ''] = match;

    if (name !== '') {
      const index = list.findIndex((node) => node.idShort === name);
      if (index < 0) return undefined;
      location = { list, index, node: list[index]! };
    }

    for (const raw of brackets.match(/\d+/g) ?? []) {
      const children = location ? childrenOf(location.node) : list;
      if (!children) return undefined;
      const index = Number(raw);
      const node = children[index];
      if (!node) return undefined;
      location = { list: children, index, node };
    }

    if (!location) return undefined;
    list = childrenOf(location.node);
  }

  return location;
}

/** Obtain the parent array to hold a new element. Create and attach it if missing */
export function containerFor(
  submodel: Submodel,
  parentPath: string | undefined,
): SubmodelElement[] | undefined {
  if (!parentPath) return (submodel.submodelElements ??= []);
  const parent = resolveIdShortPath(submodel, parentPath);
  if (!parent) return undefined;
  const node = parent.node as { value?: SubmodelElement[]; statements?: SubmodelElement[] };
  if (node.value === undefined && (parent.node.modelType === 'SubmodelElementCollection' || parent.node.modelType === 'SubmodelElementList')) {
    node.value = [];
  }
  if (node.statements === undefined && parent.node.modelType === 'Entity') {
    node.statements = [];
  }
  return childrenOf(parent.node);
}

/**
 * ValueOnly serialization ($value).
 * Only common kinds are handled — for the rest, view the full JSON (GET without $value).
 */
export function toValueOnly(node: SubmodelElement): unknown {
  switch (node.modelType) {
    case 'Property':
    case 'File':
    case 'Blob':
      return (node as { value?: string }).value ?? null;
    case 'MultiLanguageProperty':
      /**
       * Important: ValueOnly is not the metamodel representation.
       * Spec: "an array of JSON objects, one per language, **with the language as the name and the localized string as the value**"
       *   correct: [{"de": "Hersteller"}, {"en": "Maker"}]
       *   wrong:   [{"language": "de", "text": "Hersteller"}]  ← what we used to emit, copying the metamodel as-is
       * Surfaced when cross-checking against BaSyx (the reference implementation) (2026-08-24).
       */
      return ((node as { value?: LangString[] }).value ?? []).map((entry) => ({
        [entry.language]: entry.text,
      }));
    case 'Range': {
      const range = node as { min?: string; max?: string };
      return { min: range.min ?? null, max: range.max ?? null };
    }
    case 'SubmodelElementCollection':
    case 'Entity':
    case 'AnnotatedRelationshipElement': {
      const out: Record<string, unknown> = {};
      for (const child of childrenOf(node) ?? []) {
        if (child.idShort) out[child.idShort] = toValueOnly(child);
      }
      return out;
    }
    case 'SubmodelElementList':
      return (childrenOf(node) ?? []).map((child) => toValueOnly(child));
    default:
      return null;
  }
}

export class ValueNotSupportedError extends Error {}

/**
 * ValueOnly write ($value PATCH).
 *
 * Under option A (the file is the source of truth) this path is **authoring edits** — not a channel for pushing in collected values.
 * Values that come in here stay in the model and go out to the file as-is on export.
 */
export function applyValueOnly(node: SubmodelElement, value: unknown): void {
  switch (node.modelType) {
    case 'Property':
    case 'File':
    case 'Blob': {
      if (value === null) {
        delete (node as { value?: string }).value;
        return;
      }
      if (typeof value === 'object') {
        throw new ValueNotSupportedError(fill(tr('{0}의 값은 스칼라여야 합니다.'), { 0: node.modelType }));
      }
      (node as { value?: string }).value = String(value);
      return;
    }
    case 'MultiLanguageProperty': {
      if (!Array.isArray(value)) {
        throw new ValueNotSupportedError(
          tr('MultiLanguageProperty의 값은 [{"ko":"…"}] 형태의 배열이어야 합니다.'),
        );
      }
      // Accept the spec form ([{ko:"…"}]). Some clients send the metamodel form ({language,text}),
      // so accept that too — be lenient in what you accept, spec-conformant in what you emit
      (node as { value?: LangString[] }).value = value.map((entry) => {
        const record = entry as Record<string, unknown>;
        if (typeof record['language'] === 'string' && typeof record['text'] === 'string') {
          return { language: record['language'], text: record['text'] };
        }
        const keys = Object.keys(record);
        if (keys.length !== 1) {
          throw new ValueNotSupportedError(
            tr('언어 항목은 {"언어코드":"내용"} 하나이거나 {language,text}여야 합니다.'),
          );
        }
        return { language: keys[0]!, text: String(record[keys[0]!]) };
      });
      return;
    }
    case 'Range': {
      const range = value as { min?: unknown; max?: unknown } | null;
      if (range === null || typeof range !== 'object') {
        throw new ValueNotSupportedError(tr('Range의 값은 {min,max}여야 합니다.'));
      }
      const target = node as { min?: string; max?: string };
      if (range.min === null || range.min === undefined) delete target.min;
      else target.min = String(range.min);
      if (range.max === null || range.max === undefined) delete target.max;
      else target.max = String(range.max);
      return;
    }
    default:
      throw new ValueNotSupportedError(
        fill(tr('{0}은 $value 쓰기를 지원하지 않습니다. 요소 전체를 PUT하십시오.'), { 0: node.modelType }),
      );
  }
}

// ── Serialization modifiers ($metadata · $path · $reference) ────────────────────────────

/**
 * Fields that count as the value. `$metadata` is everything else.
 *
 * The spec's `*Metadata` schemas are defined as `SubmodelElementAttributes` (Referable·HasSemantics·Qualifiable·
 * HasDataSpecification·HasKind) + the per-kind **non-value** attributes.
 * So enumerating what to exclude is more accurate — the rule still holds when new element kinds appear.
 */
const VALUE_FIELDS = new Set([
  'value',
  'valueId',
  'min',
  'max',
  'statements',
  'annotations',
  'first',
  'second',
  'submodelElements',
]);

/** $metadata — everything except the value and children. Used for both Submodel and SubmodelElement */
export function toMetadata<T extends Record<string, unknown>>(node: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (VALUE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * PATCH $metadata — replace everything else without touching the value.
 * Value fields mixed into the body are ignored. That is this path's contract.
 */
export function applyMetadata(
  target: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) {
    if (VALUE_FIELDS.has(key)) continue;
    if (key === 'modelType' || key === 'id') continue; // identity is determined by the path
    delete target[key];
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (VALUE_FIELDS.has(key)) continue;
    if (key === 'modelType' || key === 'id') continue;
    target[key] = value;
  }
}

/** idShortPaths of all elements under the Submodel. Exactly the spec's PathItem format */
export function collectPaths(submodel: Submodel): string[] {
  const out: string[] = [];

  const walk = (items: readonly SubmodelElement[], parent: SubmodelElement | undefined, prefix: string): void => {
    items.forEach((node, index) => {
      const inList = parent?.modelType === 'SubmodelElementList';
      const segment = inList ? `[${index}]` : (node.idShort ?? `[${index}]`);
      const path = inList ? `${prefix}${segment}` : prefix ? `${prefix}.${segment}` : segment;
      out.push(path);
      const children = childrenOf(node);
      if (children) walk(children, node, path);
    });
  };

  walk(submodel.submodelElements ?? [], undefined, '');
  return out;
}

/** Only paths under a given element (including itself) */
export function pathsUnder(submodel: Submodel, idShortPath: string): string[] {
  return collectPaths(submodel).filter(
    (path) => path === idShortPath || path.startsWith(`${idShortPath}.`) || path.startsWith(`${idShortPath}[`),
  );
}

export interface ModelReference {
  type: 'ModelReference';
  keys: { type: string; value: string }[];
}

/** $reference — a ModelReference pointing to that resource */
export function referenceOf(keyType: string, id: string): ModelReference {
  return { type: 'ModelReference', keys: [{ type: keyType, value: id }] };
}

/** ValueOnly of an entire Submodel — spread out with child idShorts as keys */
export function submodelValueOnly(submodel: Submodel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of submodel.submodelElements ?? []) {
    if (child.idShort) out[child.idShort] = toValueOnly(child);
  }
  return out;
}
