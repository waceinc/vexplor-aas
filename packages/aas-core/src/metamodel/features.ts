/**
 * The metamodel differences between V3.0, V3.1 and V3.2 that a file's **content** can show — one table for detection
 * (which version does this need?) and for lowering (what must go to write an older version?).
 *
 * Important: detection and lowering must read the same list. If a difference were only lowered, a file would be
 *    labelled 3.0 while still holding a 3.1 value; if only detected, lowering would pass it through silently.
 *
 * Two kinds of difference:
 *  - `drop`  — a field or entry the older version has no place for (createdAt, a UoM data specification). It can be
 *              removed without changing what the rest of the model says; the removed value goes into the report.
 *  - `value` — a value the older version cannot express (AssetKind Batch, a missing entityType, a hyphen in idShort,
 *              a 2048-character id). There is no faithful substitute: writing Instance for a batch, or inventing a
 *              contentType, would state something false. Lowering refuses these unless told to keep them as they are.
 *
 * Not listed on purpose — differences that make a *higher* version stricter (3.1 requires idShort ≥ 2 characters,
 * DateTimeUtc for lastUpdate, a URI pattern for File/value; 3.2 adds AASd-137/138). They never block writing an
 * older version; checking them belongs to the linter.
 */
import { ASSET_KINDS_BY_VERSION, MAX_CONTENT_TYPE_LENGTH, MAX_IDENTIFIER_LENGTH, type MetamodelVersion } from './versions.js';

export type FeatureCode =
  | 'assetKind-role'
  | 'assetKind-batch'
  | 'administration-createdAt'
  | 'administration-updatedAt'
  | 'dataSpecificationUom'
  | 'entityType-missing'
  | 'relationship-first-missing'
  | 'relationship-second-missing'
  | 'contentType-missing'
  | 'contentType-length'
  | 'idShort-hyphen'
  | 'length-2048'
  | 'valueId-missing';

export interface FeatureHit {
  code: FeatureCode;
  kind: 'drop' | 'value';
  /** First version that allows it */
  since: MetamodelVersion;
  /** JSON Pointer of the field (or of the array entry, for a dropped entry) */
  pointer: string;
  /** Field name as written in the file */
  field: string;
  /** The value found (undefined for a missing field) */
  value: unknown;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 6901 escaping of one segment */
function seg(key: string | number): string {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Length the way the JSON schemas count it — Unicode code points, not UTF-16 units */
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

const IDENTIFIABLE_SECTIONS = new Set(['assetAdministrationShells', 'submodels', 'conceptDescriptions']);
const RELATIONSHIPS = new Set(['RelationshipElement', 'AnnotatedRelationshipElement']);

/**
 * Lists every difference found, in document order.
 * Iterative (explicit stack) so a deep model cannot overflow the call stack — the parser already caps depth, but this
 * also runs on models built in code.
 */
export function scanFeatures(environment: unknown): FeatureHit[] {
  const hits: FeatureHit[] = [];
  const hit = (code: FeatureCode, kind: FeatureHit['kind'], since: MetamodelVersion, pointer: string, field: string, value: unknown): void => {
    hits.push({ code, kind, since, pointer, field, value });
  };
  /** Text that is longer than 3.0 allows but fits 3.1 — longer than 3.1 is a schema error, not a version question */
  const length2048 = (node: Obj, field: string, pointer: string): void => {
    const v = node[field];
    if (typeof v !== 'string' || v.length <= MAX_IDENTIFIER_LENGTH['3.0']) return;
    if (codePoints(v) > MAX_IDENTIFIER_LENGTH['3.0']) hit('length-2048', 'value', '3.1', `${pointer}/${seg(field)}`, field, v);
  };
  const contentType = (node: Obj, pointer: string, required: boolean): void => {
    const v = node['contentType'];
    if (v === undefined) {
      if (required) hit('contentType-missing', 'value', '3.1', `${pointer}/contentType`, 'contentType', undefined);
      return;
    }
    if (typeof v === 'string' && codePoints(v) > MAX_CONTENT_TYPE_LENGTH['3.0']) {
      hit('contentType-length', 'value', '3.1', `${pointer}/contentType`, 'contentType', v);
    }
  };

  // [node, pointer, key it sits under (the array's key for array items), parent key]
  const stack: [unknown, string, string, string][] = [[environment, '', '', '']];
  while (stack.length > 0) {
    const [node, pointer, key, parentKey] = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], `${pointer}/${i}`, key, parentKey]);
      continue;
    }
    if (!isObj(node)) continue;

    const modelType = node['modelType'];
    if (typeof node['idShort'] === 'string' && node['idShort'].includes('-')) {
      hit('idShort-hyphen', 'value', '3.1', `${pointer}/idShort`, 'idShort', node['idShort']);
    }
    if (IDENTIFIABLE_SECTIONS.has(key) && parentKey === '') length2048(node, 'id', pointer);

    let skipChildren = false;
    switch (key) {
      case 'administration':
        for (const field of ['createdAt', 'updatedAt'] as const) {
          if (node[field] !== undefined) {
            hit(`administration-${field}`, 'drop', '3.2', `${pointer}/${field}`, field, node[field]);
          }
        }
        length2048(node, 'templateId', pointer);
        break;
      case 'assetInformation': {
        const kind = node['assetKind'];
        if (typeof kind === 'string' && !ASSET_KINDS_BY_VERSION['3.0'].includes(kind)) {
          if (ASSET_KINDS_BY_VERSION['3.1'].includes(kind)) hit('assetKind-role', 'value', '3.1', `${pointer}/assetKind`, 'assetKind', kind);
          else if (ASSET_KINDS_BY_VERSION['3.2'].includes(kind)) hit('assetKind-batch', 'value', '3.2', `${pointer}/assetKind`, 'assetKind', kind);
        }
        length2048(node, 'globalAssetId', pointer);
        length2048(node, 'assetType', pointer);
        break;
      }
      case 'defaultThumbnail':
        length2048(node, 'path', pointer);
        contentType(node, pointer, false);
        break;
      case 'keys':
      case 'specificAssetIds':
        length2048(node, 'value', pointer);
        break;
      case 'valueReferencePairs':
        length2048(node, 'value', pointer);
        if (node['valueId'] === undefined) hit('valueId-missing', 'value', '3.1', `${pointer}/valueId`, 'valueId', undefined);
        break;
      case 'embeddedDataSpecifications': {
        const content = node['dataSpecificationContent'];
        if (isObj(content) && content['modelType'] === 'DataSpecificationUom') {
          hit('dataSpecificationUom', 'drop', '3.2', pointer, 'embeddedDataSpecifications', node);
          skipChildren = true; // the whole entry goes; what is inside does not matter for older versions
        }
        break;
      }
    }

    if (modelType === 'DataSpecificationIec61360') length2048(node, 'value', pointer);
    if (modelType === 'Entity') {
      if (node['entityType'] === undefined) hit('entityType-missing', 'value', '3.1', `${pointer}/entityType`, 'entityType', undefined);
      length2048(node, 'globalAssetId', pointer);
    }
    if (typeof modelType === 'string' && RELATIONSHIPS.has(modelType)) {
      if (node['first'] === undefined) hit('relationship-first-missing', 'value', '3.1', `${pointer}/first`, 'first', undefined);
      if (node['second'] === undefined) hit('relationship-second-missing', 'value', '3.1', `${pointer}/second`, 'second', undefined);
    }
    if (modelType === 'File') {
      contentType(node, pointer, true);
      length2048(node, 'value', pointer);
    }
    if (modelType === 'Blob') contentType(node, pointer, true);

    if (skipChildren) continue;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const k = keys[i]!;
      const v = node[k];
      if (typeof v === 'object' && v !== null) stack.push([v, `${pointer}/${seg(k)}`, k, key]);
    }
  }
  return hits;
}
