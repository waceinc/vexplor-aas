/**
 * idShortPath 해석과 ValueOnly 직렬화.
 *
 * IDTA Part 2는 SubmodelElement를 `Markings.MarkingsEntry[0].Name` 같은 **idShortPath**로 가리킨다.
 * 점(.)이 계층, 대괄호가 SubmodelElementList의 인덱스다.
 * 순회 규칙은 @aas/core의 traverse와 같아야 한다 — 린터가 보고하는 위치와 API가 가리키는 위치가
 * 어긋나면 저작 UI에서 "지적된 그 요소"를 열 수 없다.
 */
import type { LangString, Submodel, SubmodelElement } from '@aas/core';

export interface ElementLocation {
  /** node를 담고 있는 배열 */
  list: SubmodelElement[];
  /** list 안에서의 위치 */
  index: number;
  node: SubmodelElement;
}

/** 자식을 담는 필드 — traverse.ts의 childrenOf와 같은 규칙 */
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

/** 새 요소를 담을 부모 배열을 확보한다. 없으면 만들어 붙인다 */
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
 * ValueOnly 직렬화($value).
 * 자주 쓰는 종류만 다룬다 — 나머지는 통짜 JSON(GET without $value)으로 보면 된다.
 */
export function toValueOnly(node: SubmodelElement): unknown {
  switch (node.modelType) {
    case 'Property':
    case 'File':
    case 'Blob':
      return (node as { value?: string }).value ?? null;
    case 'MultiLanguageProperty':
      /**
       * 🔴 ValueOnly는 메타모델 표현이 아니다.
       * 규격: "각 언어마다 **언어를 이름으로, 지역화 문자열을 값으로** 갖는 JSON 객체의 배열"
       *   맞음: [{"ko": "제조사"}, {"en": "Maker"}]
       *   틀림: [{"language": "ko", "text": "제조사"}]  ← 메타모델 그대로 내보내던 것
       * BaSyx(참조 구현)와 대조하다 드러났다(2026-08-24).
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
 * ValueOnly 쓰기($value PATCH).
 *
 * A안(파일이 원본)에서 이 경로는 **저작 편집**이다 — 수집값을 밀어 넣는 통로가 아니다.
 * 여기로 들어온 값은 모델에 남고 export하면 파일에 그대로 나간다.
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
        throw new ValueNotSupportedError(`${node.modelType}의 값은 스칼라여야 합니다.`);
      }
      (node as { value?: string }).value = String(value);
      return;
    }
    case 'MultiLanguageProperty': {
      if (!Array.isArray(value)) {
        throw new ValueNotSupportedError(
          'MultiLanguageProperty의 값은 [{"ko":"…"}] 형태의 배열이어야 합니다.',
        );
      }
      // 규격 형태([{ko:"…"}])를 받는다. 메타모델 형태({language,text})로 보내는 클라이언트도
      // 있어 함께 받아 준다 — 받는 쪽은 너그럽게, 내보내는 쪽은 규격대로
      (node as { value?: LangString[] }).value = value.map((entry) => {
        const record = entry as Record<string, unknown>;
        if (typeof record['language'] === 'string' && typeof record['text'] === 'string') {
          return { language: record['language'], text: record['text'] };
        }
        const keys = Object.keys(record);
        if (keys.length !== 1) {
          throw new ValueNotSupportedError(
            '언어 항목은 {"언어코드":"내용"} 하나이거나 {language,text}여야 합니다.',
          );
        }
        return { language: keys[0]!, text: String(record[keys[0]!]) };
      });
      return;
    }
    case 'Range': {
      const range = value as { min?: unknown; max?: unknown } | null;
      if (range === null || typeof range !== 'object') {
        throw new ValueNotSupportedError('Range의 값은 {min,max}여야 합니다.');
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
        `${node.modelType}은 $value 쓰기를 지원하지 않습니다. 요소 전체를 PUT하십시오.`,
      );
  }
}

// ── 직렬화 수식자 ($metadata · $path · $reference) ────────────────────────────

/**
 * 값에 해당하는 필드. `$metadata`는 이것들을 뺀 나머지다.
 *
 * 규격의 `*Metadata` 스키마는 `SubmodelElementAttributes`(Referable·HasSemantics·Qualifiable·
 * HasDataSpecification·HasKind) + 종류별 **값이 아닌** 속성으로 정의된다.
 * 그래서 뺄 것을 세는 편이 정확하다 — 새 요소 종류가 생겨도 규칙이 그대로 선다.
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

/** $metadata — 값과 자식을 뺀 나머지. Submodel과 SubmodelElement 모두에 쓴다 */
export function toMetadata<T extends Record<string, unknown>>(node: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (VALUE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * PATCH $metadata — 값은 건드리지 않고 나머지만 갈아 끼운다.
 * 값 필드가 본문에 섞여 와도 무시한다. 그게 이 경로의 계약이다.
 */
export function applyMetadata(
  target: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) {
    if (VALUE_FIELDS.has(key)) continue;
    if (key === 'modelType' || key === 'id') continue; // 신원은 경로가 정한다
    delete target[key];
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (VALUE_FIELDS.has(key)) continue;
    if (key === 'modelType' || key === 'id') continue;
    target[key] = value;
  }
}

/** Submodel 아래 모든 요소의 idShortPath. 규격의 PathItem 형식 그대로다 */
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

/** 어떤 요소 아래의 경로만 (자기 자신 포함) */
export function pathsUnder(submodel: Submodel, idShortPath: string): string[] {
  return collectPaths(submodel).filter(
    (path) => path === idShortPath || path.startsWith(`${idShortPath}.`) || path.startsWith(`${idShortPath}[`),
  );
}

export interface ModelReference {
  type: 'ModelReference';
  keys: { type: string; value: string }[];
}

/** $reference — 그 자원을 가리키는 ModelReference */
export function referenceOf(keyType: string, id: string): ModelReference {
  return { type: 'ModelReference', keys: [{ type: keyType, value: id }] };
}

/** Submodel 전체의 ValueOnly — 자식 idShort를 키로 편다 */
export function submodelValueOnly(submodel: Submodel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of submodel.submodelElements ?? []) {
    if (child.idShort) out[child.idShort] = toValueOnly(child);
  }
  return out;
}
