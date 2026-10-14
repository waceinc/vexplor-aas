/**
 * Reading XML-serialized AASX.
 *
 * Why: existing tools, including Package Explorer, often provide **AASX saved as XML**.
 * If we cannot open them, we cannot call ourselves a "replacement". Writing stays JSON-only (we do not split the lossless round-trip path in two).
 *
 * Three things are tricky in the spec's XML<->JSON mapping.
 *  ① **The kind is carried in the element name.** `<property>` -> `modelType: 'Property'`.
 *     JSON requires a `modelType` field, so we create it here
 *  ② **Order must not be lost.** SubmodelElementList **refers to children by position** (AASd-120).
 *     A parser that groups by name loses order where different kinds are mixed ->
 *     read in document order with `preserveOrder: true`
 *  ③ The same name (`<value>`) means different things in different places: text in Property, a child list in SMC,
 *     per-language text in MultiLanguageProperty -> **array if the children are elements, string if text**
 */
import { XMLParser } from 'fast-xml-parser';
import { fill, tr, type Environment } from '@aas/core';

/** Parser that preserves document order. Namespace prefixes (aas:) are stripped */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Important: do not trim values. This path opens other people's files — even a single trailing space is not ours to remove.
  //    (Measured: 5 German descriptions in the golden file end with a space. Trimming silently changes them)
  trimValues: false,
  parseTagValue: false, // Keep number-like values as text — ids and versions must not turn into numbers
});

/** Node produced by preserveOrder: an object with a single key */
type XmlNode = Record<string, unknown>;

const TEXT = '#text';

function nameOf(node: XmlNode): string {
  const keys = Object.keys(node).filter((key) => key !== ':@');
  return keys[0] ?? '';
}

function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[nameOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

/**
 * Whether there are no element children, only text.
 *
 * In indented XML, **line breaks between elements** arrive as text nodes, as in `<a>\n  <b/>\n</a>`.
 * That is formatting, not a value, so it is treated as an empty element — but only **when a line break is present**.
 * This is needed to distinguish values that genuinely end with whitespace.
 */
function textOf(children: XmlNode[]): string | undefined {
  if (children.length === 0) return '';
  if (children.length === 1 && TEXT in children[0]!) {
    const text = String(children[0]![TEXT] ?? '');
    if (text.includes('\n') && text.trim() === '') return '';
    return text;
  }
  return undefined;
}

/**
 * Elements whose name is their kind.
 * When an element appears under one of these names, `modelType` is created for it.
 */
const MODEL_TYPES = new Set([
  'assetAdministrationShell',
  'submodel',
  'conceptDescription',
  'property',
  'multiLanguageProperty',
  'range',
  'blob',
  'file',
  'referenceElement',
  'relationshipElement',
  'annotatedRelationshipElement',
  'submodelElementCollection',
  'submodelElementList',
  'entity',
  'capability',
  'operation',
  'basicEventElement',
]);

/**
 * Names of **repeated items** inside a wrapper.
 * Must be an array even with a single item — deciding by count would turn a one-item list into an object and silently break.
 */
const ITEM_NAMES = new Set([
  ...MODEL_TYPES,
  'key',
  'reference',
  'specificAssetId',
  'extension',
  'qualifier',
  'embeddedDataSpecification',
  'valueReferencePair',
  'langStringNameType',
  'langStringTextType',
  'langStringPreferredNameTypeIec61360',
  'langStringShortNameTypeIec61360',
  'langStringDefinitionTypeIec61360',
  'operationVariable',
]);

/**
 * Places where a **single** child states the kind.
 * `<dataSpecificationContent><dataSpecificationIec61360>...` -> in JSON this is
 * a single object `dataSpecificationContent: { modelType: 'DataSpecificationIec61360', ... }`.
 * Reading it as a list yields an array and breaks the schema (caught by measurement).
 */
const TYPED_SINGLE_WRAPPERS = new Set(['dataSpecificationContent']);
const TYPED_CONTENT_NAMES = new Set(['dataSpecificationIec61360']);

/** Fields that must be read as true/false — leaving them as text breaks the schema */
const BOOLEAN_FIELDS = new Set(['orderRelevant', 'min', 'max', 'nom', 'typ']);

/** Not `langStringTextType` -> `LangStringTextType`; in JSON these are unnamed objects */
const UNNAMED_ITEMS = new Set([
  'key',
  'reference',
  'specificAssetId',
  'extension',
  'qualifier',
  'embeddedDataSpecification',
  'valueReferencePair',
  'langStringNameType',
  'langStringTextType',
  'langStringPreferredNameTypeIec61360',
  'langStringShortNameTypeIec61360',
  'langStringDefinitionTypeIec61360',
  'operationVariable',
]);

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Converts one element into a JSON value */
function toValue(node: XmlNode, field: string): unknown {
  const children = childrenOf(node);
  const text = textOf(children);
  if (text !== undefined) {
    if (BOOLEAN_FIELDS.has(field)) return text === 'true';
    return text;
  }

  const out: Record<string, unknown> = {};
  // Where the name is the kind, create modelType (JSON requires it)
  const own = nameOf(node);
  if (MODEL_TYPES.has(own) && !UNNAMED_ITEMS.has(own)) out['modelType'] = pascal(own);

  for (const child of children) {
    const childName = nameOf(child);
    if (childName === '' || childName === TEXT) continue;
    const grandChildren = childrenOf(child);

    const items = grandChildren.filter((g) => !(TEXT in g));

    // A single child states the kind — one object, not an array
    if (TYPED_SINGLE_WRAPPERS.has(childName) && items.length === 1) {
      const only = items[0]!;
      const converted = toValue(only, nameOf(only)) as Record<string, unknown>;
      if (TYPED_CONTENT_NAMES.has(nameOf(only))) converted['modelType'] = pascal(nameOf(only));
      out[childName] = converted;
      continue;
    }

    // Is it a wrapper? — if every child has an "item name", it is an array
    const allItems = items.length > 0 && items.every((g) => ITEM_NAMES.has(nameOf(g)));
    if (allItems) {
      out[childName] = items.map((item) => toValue(item, nameOf(item)));
      continue;
    }
    out[childName] = toValue(child, childName);
  }
  return out;
}

/** Flattens a top-level wrapper (`<submodels>`, etc.) into an array */
function toList(node: XmlNode): unknown[] {
  return childrenOf(node)
    .filter((child) => !(TEXT in child))
    .map((child) => toValue(child, nameOf(child)));
}

export class AasxXmlError extends Error {}

/**
 * Converts an XML body into an Environment.
 * Important: this is a **read-only path**. Saving rewrites as JSON (writeAasx).
 */
export function parseEnvironmentXml(text: string): Environment {
  let tree: XmlNode[];
  try {
    tree = parser.parse(text) as XmlNode[];
  } catch (error) {
    throw new AasxXmlError(fill(tr('XML을 해석하지 못했습니다: {0}'), { 0: String(error) }));
  }

  const root = tree.find((node) => nameOf(node) === 'environment');
  if (!root) throw new AasxXmlError(tr('<environment> 요소가 없습니다.'));

  const environment: Record<string, unknown> = {};
  for (const child of childrenOf(root)) {
    const name = nameOf(child);
    if (name === 'assetAdministrationShells' || name === 'submodels' || name === 'conceptDescriptions') {
      const list = toList(child);
      // Important: do not add empty arrays — the official schema does not allow them (PKG-EMPTY-ARRAY)
      if (list.length > 0) environment[name] = list;
    }
  }
  return environment as unknown as Environment;
}
