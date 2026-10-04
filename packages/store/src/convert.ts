/**
 * 저장 레코드 ↔ AAS 구조 변환.
 *
 * 무손실이 유일한 목표다. 파생 컬럼(idShort·semanticId 등)은 **조회 편의를 위한 사본**이며,
 * 되돌릴 때는 언제나 content(원본 JSON)만 쓴다 — 파생과 원본이 어긋나면 원본이 이긴다(A안).
 */
import type { AasxFile, AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import {
  ENVIRONMENT_FIELD,
  IDENTIFIABLE_MODEL_TYPES,
  InvalidContentError,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type PackageFileRecord,
  type PackageRecord,
} from './types.js';

/** content에서 뽑아내는 조회용 컬럼 */
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

/** Reference의 첫 키 값 — 린터의 firstKeyValue와 같은 규칙 */
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
      `modelType이 Identifiable 3종(${IDENTIFIABLE_MODEL_TYPES.join(' · ')}) 중 하나여야 합니다: ${modelType ?? '없음'}`,
    );
  }
  const id = stringOf(content['id']);
  if (!id) throw new InvalidContentError('Identifiable에는 id가 있어야 합니다.');

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

/** Environment → 저장 레코드의 재료. 배열 순서를 ordinal로 남긴다 */
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
 * 저장 레코드 → Environment.
 * modelType별로 ordinal 오름차순 — 원본 배열 순서가 그대로 살아난다.
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

/** AASX 패키지의 비모델 파트를 레코드로 편다 */
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

/** 레코드 → AASX 패키지. writeAasx에 그대로 넘길 수 있는 형태 */
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
      // 번들 첨부는 AASX 파트가 아니다 — 넣으면 공정 파일 해시가 바뀐다
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
