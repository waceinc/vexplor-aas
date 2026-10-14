/**
 * Auto-fix helper functions.
 *
 * Everything here shares one concern — **a fix must not break anything elsewhere**.
 * For fixes that change an id, referential integrity is key (replaceIdEverywhere),
 * and fixes that choose a dataType must not create a new AASc-3a-009 (unit required) violation (pickDataType).
 */
import {
  IEC61360_TEMPLATE_IRI,
  parsePointer,
  type AssetAdministrationShell,
  type ConceptDescription,
  type DataSpecificationIec61360,
  type DataTypeDefXsd,
  type DataTypeIec61360,
  type Environment,
  type Identifiable,
  type Key,
  type LangString,
  type Property,
  type Submodel,
  type SubmodelElement,
} from '@aas/core';
import { KOSMO_ALLOWED_DATA_TYPES, needsUnit, XS_TO_DATA_TYPE } from '../util.js';

/** Tokens accepted as version segments — digits only. The 3 and 1 in `.../DigitalNameplate/3/1` */
const VERSION_TOKEN = /^\d+$/;

export interface VersionPair {
  version: string;
  revision: string;
}

/** Interprets the last two id segments as version · revision. Gives up if they are not numeric */
export function versionFromId(id: string): VersionPair | undefined {
  const parts = id.split('/');
  if (parts.length < 2) return undefined;
  const version = parts[parts.length - 2];
  const revision = parts[parts.length - 1];
  if (!version || !revision) return undefined;
  if (!VERSION_TOKEN.test(version) || !VERSION_TOKEN.test(revision)) return undefined;
  return { version, revision };
}

/** Replaces the last two id segments with the given version. Appends them if there is no version slot */
export function withVersionSuffix(id: string, version: string, revision: string): string {
  const parts = id.split('/');
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (
    parts.length >= 2 &&
    last !== undefined &&
    secondLast !== undefined &&
    VERSION_TOKEN.test(last) &&
    VERSION_TOKEN.test(secondLast)
  ) {
    return [...parts.slice(0, -2), version, revision].join('/');
  }
  return `${id.replace(/\/+$/, '')}/${version}/${revision}`;
}

/** administration first; otherwise the id suffix; otherwise 1/0 */
export function versionOf(item: Identifiable): VersionPair {
  const admin = item.administration;
  if (admin?.version && admin.revision) {
    return { version: admin.version, revision: admin.revision };
  }
  return versionFromId(item.id) ?? { version: '1', revision: '0' };
}

// ── Locating targets by pointer ──────────────────────────────────────────────

/** Takes the N-th item of a top-level array, as in `/submodels/3/...` */
function rootItem(env: Environment, pointer: string): unknown {
  const segments = parsePointer(pointer);
  const field = segments[0];
  const index = segments[1];
  if (field === undefined || index === undefined) return undefined;
  const list = (env as unknown as Record<string, unknown>)[field];
  if (!Array.isArray(list)) return undefined;
  return list[Number(index)];
}

export function shellAt(env: Environment, pointer: string): AssetAdministrationShell | undefined {
  const item = rootItem(env, pointer);
  return isModelType(item, 'AssetAdministrationShell') ? (item as AssetAdministrationShell) : undefined;
}

export function submodelAt(env: Environment, pointer: string): Submodel | undefined {
  const item = rootItem(env, pointer);
  return isModelType(item, 'Submodel') ? (item as Submodel) : undefined;
}

export function conceptDescriptionAt(env: Environment, pointer: string): ConceptDescription | undefined {
  const item = rootItem(env, pointer);
  return isModelType(item, 'ConceptDescription') ? (item as ConceptDescription) : undefined;
}

function isModelType(value: unknown, modelType: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { modelType?: unknown }).modelType === modelType
  );
}

/** Whether a value is a SubmodelElement — any object with a modelType string is treated as one */
export function asElement(value: unknown): SubmodelElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return typeof (value as { modelType?: unknown }).modelType === 'string'
    ? (value as SubmodelElement)
    : undefined;
}

// ── Referential integrity ────────────────────────────────────────────────────

function isKey(value: unknown): value is Key {
  if (typeof value !== 'object' || value === null) return false;
  const k = value as { type?: unknown; value?: unknown };
  return typeof k.type === 'string' && typeof k.value === 'string';
}

/**
 * Replaces every Reference key pointing to oldId across the Environment with newId.
 * In AAS, submodels[] · semanticId · valueId · unitId · isCaseOf are all References, so they are handled in one pass.
 * The id field of the Identifiable itself is not touched — the caller changes it explicitly.
 *
 * @returns number of keys updated
 */
export function replaceIdEverywhere(env: Environment, oldId: string, newId: string): number {
  if (oldId === newId) return 0;
  let count = 0;
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['keys'])) {
      for (const k of obj['keys'] as unknown[]) {
        if (isKey(k) && k.value === oldId) {
          k.value = newId;
          count += 1;
        }
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };

  walk(env);
  return count;
}

/** Whether the id is already in use — prevents a new id created by a fix from colliding with someone else's id */
export function idExists(env: Environment, id: string, except?: Identifiable): boolean {
  const all: Identifiable[] = [
    ...(env.assetAdministrationShells ?? []),
    ...(env.submodels ?? []),
    ...(env.conceptDescriptions ?? []),
  ];
  return all.some((item) => item !== except && item.id === id);
}

// ── ConceptDescription creation ──────────────────────────────────────────────

/**
 * Picks one of the dataType candidates.
 * Choosing *_MEASURE without a unit would create a new AASc-3a-009 violation,
 * so when there is no unit, candidates that do not require a unit are used first.
 */
export function pickDataType(
  candidates: readonly string[],
  content?: Pick<DataSpecificationIec61360, 'unit' | 'unitId'>,
): DataTypeIec61360 | undefined {
  const allowed = candidates.filter((c) => KOSMO_ALLOWED_DATA_TYPES.has(c));
  if (allowed.length === 0) return undefined;
  const hasUnit = Boolean(content?.unit ?? content?.unitId);
  const preferred = hasUnit
    ? allowed.find((c) => needsUnit(c))
    : allowed.find((c) => !needsUnit(c));
  return (preferred ?? allowed[0]) as DataTypeIec61360;
}

/** Infers the CD's dataType from the element's properties — only as far as it does not invent an interpretation of the value */
export function inferDataType(node: SubmodelElement): DataTypeIec61360 {
  if (node.modelType === 'Property' || node.modelType === 'Range') {
    const candidates = XS_TO_DATA_TYPE[(node as Property).valueType];
    const picked = candidates ? pickDataType(candidates) : undefined;
    if (picked) return picked;
  }
  if (node.modelType === 'MultiLanguageProperty') return 'STRING_TRANSLATABLE';
  return 'STRING';
}

/** Builds an IEC 61360 data specification in the same shape as the golden file */
export function makeIec61360(idShort: string, dataType: DataTypeIec61360): DataSpecificationIec61360 {
  const label: LangString[] = [{ language: 'en', text: idShort }];
  return {
    modelType: 'DataSpecificationIec61360',
    preferredName: label,
    dataType,
    // Do not invent a definition — the golden file also left idShort as-is for entries without a definition.
    // It is a placeholder that assumes a human will replace it with the original text from the development plan.
    definition: [{ language: 'en', text: idShort }],
  };
}

/** Creates the ConceptDescription that a semanticId points to but that does not exist */
export function makeConceptDescription(
  id: string,
  idShort: string,
  dataType: DataTypeIec61360,
): ConceptDescription {
  return {
    modelType: 'ConceptDescription',
    id,
    idShort,
    embeddedDataSpecifications: [
      {
        dataSpecification: {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: IEC61360_TEMPLATE_IRI }],
        },
        dataSpecificationContent: makeIec61360(idShort, dataType),
      },
    ],
  };
}

/**
 * Deep copy of an Environment.
 *
 * Uses a JSON round trip instead of structuredClone — the linter must be pure logic that also runs unchanged in the
 * M3 authoring UI (browser), so it does not rely on @types/node globals.
 * An AAS Environment is by definition plain JSON (proven by the M2 canonicalJson round trip), so nothing is lost.
 */
export function cloneEnvironment(env: Environment): Environment {
  return JSON.parse(JSON.stringify(env)) as Environment;
}

// ── Miscellaneous ────────────────────────────────────────────────────────────

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function extensionOf(part: string): string {
  const dot = part.lastIndexOf('.');
  return dot < 0 ? '' : part.slice(dot + 1).toLowerCase();
}

export function imageContentType(part: string): string {
  return IMAGE_CONTENT_TYPES[extensionOf(part)] ?? 'application/octet-stream';
}

/** Picks the package part to use as the thumbnail image. Parts with thumbnail in the name are preferred */
export function findThumbnailPart(parts: readonly string[]): string | undefined {
  const images = parts.filter((p) => extensionOf(p) in IMAGE_CONTENT_TYPES);
  return images.find((p) => /thumbnail/i.test(p)) ?? images[0];
}

/**
 * dataType → Property.valueType reverse mapping.
 * The opposite direction of XS_TO_DATA_TYPE, containing only values that round-trip
 * (values that do not come back, such as INTEGER_CURRENCY · RATIONAL · IRDI, are deliberately excluded — fixing would not converge).
 */
export const DATA_TYPE_TO_XS: Partial<Record<DataTypeIec61360, DataTypeDefXsd>> = {
  STRING: 'xs:string',
  STRING_TRANSLATABLE: 'xs:string',
  IRI: 'xs:anyURI',
  DATE: 'xs:date',
  TIMESTAMP: 'xs:dateTime',
  TIME: 'xs:time',
  BOOLEAN: 'xs:boolean',
  INTEGER_COUNT: 'xs:int',
  INTEGER_MEASURE: 'xs:int',
  REAL_COUNT: 'xs:double',
  REAL_MEASURE: 'xs:double',
};

/** Returns the valueType after confirming the round trip holds */
export function valueTypeFor(dataType: string): DataTypeDefXsd | undefined {
  const xs = DATA_TYPE_TO_XS[dataType as DataTypeIec61360];
  if (!xs) return undefined;
  return XS_TO_DATA_TYPE[xs]?.includes(dataType) ? xs : undefined;
}
