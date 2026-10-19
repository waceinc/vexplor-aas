/**
 * Conversion between stored records and AAS structures.
 *
 * Losslessness is the only goal. Derived columns (idShort, semanticId, etc.) are **copies for query convenience**;
 * restoring always uses content (the original JSON) only — if derived and original disagree, the original wins (Option A).
 */
import type { AasxFile, AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { detectMetamodelVersion, fill, METAMODEL_VERSIONS, tr } from '@aas/core';
import {
  ENVIRONMENT_FIELD,
  IDENTIFIABLE_MODEL_TYPES,
  InvalidContentError,
  LEGACY_PACKAGE_METAMODEL,
  type PackageMetamodel,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type PackageFileRecord,
  type PackageRecord,
} from './types.js';

/** Query columns extracted from content */
export interface DerivedColumns {
  modelType: IdentifiableModelType;
  id: string;
  idShort?: string;
  semanticId?: string;
  assetKind?: string;
  kind?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** First key value of a Reference — same rule as the linter's firstKeyValue */
function firstKeyValue(reference: unknown): string | undefined {
  const ref = asRecord(reference);
  const keys = ref?.['keys'];
  if (!Array.isArray(keys)) return undefined;
  return stringOf(asRecord(keys[0])?.['value']);
}

export function deriveColumns(content: Record<string, unknown>): DerivedColumns {
  const modelType = stringOf(content['modelType']);
  if (!modelType || !IDENTIFIABLE_MODEL_TYPES.includes(modelType as IdentifiableModelType)) {
    throw new InvalidContentError(
      fill(tr('modelType이 Identifiable 3종({0}) 중 하나여야 합니다: {1}'), {
        0: IDENTIFIABLE_MODEL_TYPES.join(' · '),
        1: modelType ?? tr('없음'),
      }),
    );
  }
  const id = stringOf(content['id']);
  if (!id) throw new InvalidContentError(tr('Identifiable에는 id가 있어야 합니다.'));

  const derived: DerivedColumns = { modelType: modelType as IdentifiableModelType, id };
  const idShort = stringOf(content['idShort']);
  if (idShort) derived.idShort = idShort;

  const semanticId = firstKeyValue(content['semanticId']);
  if (semanticId) derived.semanticId = semanticId;

  const assetKind = stringOf(asRecord(content['assetInformation'])?.['assetKind']);
  if (assetKind) derived.assetKind = assetKind;

  const kind = stringOf(content['kind']);
  if (kind) derived.kind = kind;

  return derived;
}

/** Environment → raw material for stored records. Array order is kept as ordinal */
export function flattenEnvironment(
  env: Environment,
): { content: Record<string, unknown>; ordinal: number }[] {
  const out: { content: Record<string, unknown>; ordinal: number }[] = [];
  let ordinal = 0;
  for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
    const list = env[ENVIRONMENT_FIELD[modelType]] ?? [];
    for (const item of list) {
      out.push({ content: item as unknown as Record<string, unknown>, ordinal });
      ordinal += 1;
    }
  }
  return out;
}

/**
 * Stored records → Environment.
 * Ascending ordinal per modelType — the original array order is restored as-is.
 */
export function toEnvironment(records: readonly IdentifiableRecord[]): Environment {
  const env: Environment = {};
  for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
    const items = records
      .filter((r) => r.modelType === modelType)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => r.content);
    if (items.length > 0) {
      (env as Record<string, unknown>)[ENVIRONMENT_FIELD[modelType]] = items;
    }
  }
  return env;
}

/** Flattens the non-model parts of an AASX package into records */
export function flattenPackageFiles(pkg: AasxPackage): PackageFileRecord[] {
  const files: PackageFileRecord[] = [];
  if (pkg.thumbnail) {
    files.push({
      part: pkg.thumbnail.part,
      role: 'thumbnail',
      contentType: pkg.thumbnail.contentType,
      data: pkg.thumbnail.data,
    });
  }
  for (const f of pkg.supplementaryFiles) {
    files.push({ part: f.part, role: 'supplementary', contentType: f.contentType, data: f.data });
  }
  for (const [part, data] of pkg.extraParts) {
    files.push({ part, role: 'extra', contentType: '', data });
  }
  return files;
}

/** Records → AASX package. In a form that can be passed straight to writeAasx */
export function toAasxPackage(
  record: PackageRecord,
  files: readonly PackageFileRecord[],
  environment: Environment,
): AasxPackage {
  const supplementaryFiles: AasxFile[] = [];
  const extraParts = new Map<string, Uint8Array>();
  let thumbnail: AasxFile | undefined;

  for (const f of files) {
    if (f.role === 'thumbnail') {
      thumbnail = { part: f.part, contentType: f.contentType, data: f.data };
    } else if (f.role === 'supplementary') {
      supplementaryFiles.push({ part: f.part, contentType: f.contentType, data: f.data });
    } else if (f.role === 'bundle') {
      // Bundle attachments are not AASX parts — including them would change the process file hash
      continue;
    } else {
      extraParts.set(f.part, f.data);
    }
  }

  const pkg: AasxPackage = {
    environment,
    specPart: record.specPart,
    supplementaryFiles,
    extraParts,
  };
  if (thumbnail) pkg.thumbnail = thumbnail;
  return pkg;
}

/** A stored version value read back — anything unknown (a hand-edited folder, a NULL column) is a pre-version package */
export function storedMetamodel(version: unknown, inferred: unknown): PackageMetamodel {
  if (typeof version !== 'string' || !(METAMODEL_VERSIONS as readonly string[]).includes(version)) {
    return { ...LEGACY_PACKAGE_METAMODEL };
  }
  return { version: version as PackageMetamodel['version'], inferred: inferred === true };
}

/**
 * The version importPackage remembers: the one the caller gives, else the one `readAasx` found (its result carries a
 * `metamodel`), else the lowest version that holds the content.
 * Important: only `version` and `inferred` are kept — the evidence list belongs to one reading of one file and goes
 *    stale with the first edit.
 */
export function packageMetamodelOf(input: { package: AasxPackage; metamodel?: PackageMetamodel }): PackageMetamodel {
  if (input.metamodel) return storedMetamodel(input.metamodel.version, input.metamodel.inferred);
  const read = (input.package as AasxPackage & { metamodel?: { version?: unknown; inferred?: unknown } }).metamodel;
  if (read && typeof read === 'object') return storedMetamodel(read.version, read.inferred);
  return { version: detectMetamodelVersion(input.package.environment).version, inferred: true };
}
