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
import { fill, tr, versionFromNamespace, type Environment, type MetamodelVersion } from '@aas/core';

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
  'langStringUom',
  'langStringDefinitionTypeUom',
  'operationVariable',
]);

/**
 * Places where a **single** child states the kind.
 * `<dataSpecificationContent><dataSpecificationIec61360>...` -> in JSON this is
 * a single object `dataSpecificationContent: { modelType: 'DataSpecificationIec61360', ... }`.
 * Reading it as a list yields an array and breaks the schema (caught by measurement).
 */
const TYPED_SINGLE_WRAPPERS = new Set(['dataSpecificationContent']);
// dataSpecificationUom: V3.2 (unit-of-measure data specification, IDTA-01003-b)
const TYPED_CONTENT_NAMES = new Set(['dataSpecificationIec61360', 'dataSpecificationUom']);

/**
 * Fields that must be read as true/false — leaving them as text breaks the schema.
 * Important: min/max/nom/typ are booleans **only inside levelType**. Range has text fields of the same names; reading
 *    those as booleans turned every Range bound into `false` (found with the official 3.0 examples, 2026-10-19).
 */
const BOOLEAN_FIELDS = new Set(['orderRelevant']);
const LEVEL_TYPE_FIELDS = new Set(['min', 'max', 'nom', 'typ']);

/**
 * Elements that are objects even when written empty (`<administration/>`, `<capability/>` in a list).
 * Without this an empty element became the empty string — every field of AdministrativeInformation is optional, so
 * `<administration/>` is valid and common.
 */
const OBJECT_WHEN_EMPTY = new Set(['administration']);

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
  'langStringUom',
  'langStringDefinitionTypeUom',
  'operationVariable',
]);

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Converts one element into a JSON value. `parent` is the name of the element that holds it */
function toValue(node: XmlNode, field: string, parent = ''): unknown {
  const children = childrenOf(node);
  const own = nameOf(node);
  const text = textOf(children);
  const isObject = MODEL_TYPES.has(own) || OBJECT_WHEN_EMPTY.has(own) || TYPED_CONTENT_NAMES.has(own);
  if (text !== undefined && !(text === '' && isObject)) {
    if (BOOLEAN_FIELDS.has(field) || (parent === 'levelType' && LEVEL_TYPE_FIELDS.has(field))) return text === 'true';
    return text;
  }

  const out: Record<string, unknown> = {};
  // Where the name is the kind, create modelType (JSON requires it)
  if (MODEL_TYPES.has(own) && !UNNAMED_ITEMS.has(own)) out['modelType'] = pascal(own);

  for (const child of children) {
    const childName = nameOf(child);
    if (childName === '' || childName === TEXT) continue;
    const grandChildren = childrenOf(child);

    const items = grandChildren.filter((g) => !(TEXT in g));

    // A single child states the kind — one object, not an array
    if (TYPED_SINGLE_WRAPPERS.has(childName) && items.length === 1) {
      const only = items[0]!;
      const converted = toValue(only, nameOf(only), childName) as Record<string, unknown>;
      if (TYPED_CONTENT_NAMES.has(nameOf(only))) converted['modelType'] = pascal(nameOf(only));
      out[childName] = converted;
      continue;
    }

    // OperationVariable/value holds exactly one SubmodelElement — an object in JSON, not a one-item list.
    // (Found with the official examples: it was read as an array.)
    if (own === 'operationVariable' && childName === 'value' && items.length === 1) {
      const only = items[0]!;
      out[childName] = toValue(only, nameOf(only), childName);
      continue;
    }

    // Is it a wrapper? — if every child has an "item name", it is an array
    const allItems = items.length > 0 && items.every((g) => ITEM_NAMES.has(nameOf(g)));
    if (allItems) {
      out[childName] = items.map((item) => toValue(item, nameOf(item), childName));
      continue;
    }
    out[childName] = toValue(child, childName, own);
  }
  return out;
}

/** Flattens a top-level wrapper (`<submodels>`, etc.) into an array */
function toList(node: XmlNode): unknown[] {
  return childrenOf(node)
    .filter((child) => !(TEXT in child))
    .map((child) => toValue(child, nameOf(child), nameOf(node)));
}

export class AasxXmlError extends Error {}

/**
 * The metamodel version an XML body declares, from the namespace of its `<environment>` root
 * (`https://admin-shell.io/aas/3/0` · `/3/1` · `/3/2`). Undefined when the root has no AAS namespace or names a version
 * this code does not know.
 * Important: read from the root start tag only — the parser strips prefixes and ignores attributes, so the namespace
 *    is no longer visible after parsing. A prefixed root (`<aas:environment xmlns:aas="…">`) uses the prefix's binding.
 */
export function xmlMetamodelVersion(text: string): MetamodelVersion | undefined {
  const root = /<(?:([A-Za-z_][\w.-]*):)?environment\b([^>]*)>/.exec(text);
  if (!root) return undefined;
  const prefix = root[1];
  const attributes = root[2] ?? '';
  const name = prefix ? `xmlns:${prefix}` : 'xmlns';
  const declared = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
  if (!declared) return undefined;
  return versionFromNamespace(declared[2] ?? declared[3] ?? '');
}

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
