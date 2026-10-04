/**
 * 자동수정 보조 함수.
 *
 * 여기 모인 것들의 공통 관심사는 하나다 — **교정이 다른 곳을 깨뜨리지 않게 하는 것**.
 * id를 바꾸는 교정은 참조 무결성이 핵심이고(replaceIdEverywhere),
 * dataType을 정하는 교정은 AASc-3a-009(단위 필수)를 새로 만들어내지 않아야 한다(pickDataType).
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

/** 버전 세그먼트로 인정하는 토큰 — 숫자만. `.../DigitalNameplate/3/1` 의 3·1 */
const VERSION_TOKEN = /^\d+$/;

export interface VersionPair {
  version: string;
  revision: string;
}

/** id의 끝 두 세그먼트를 version·revision으로 해석한다. 숫자가 아니면 포기한다 */
export function versionFromId(id: string): VersionPair | undefined {
  const parts = id.split('/');
  if (parts.length < 2) return undefined;
  const version = parts[parts.length - 2];
  const revision = parts[parts.length - 1];
  if (!version || !revision) return undefined;
  if (!VERSION_TOKEN.test(version) || !VERSION_TOKEN.test(revision)) return undefined;
  return { version, revision };
}

/** id의 끝 두 세그먼트를 주어진 버전으로 교체한다. 버전 자리가 없으면 덧붙인다 */
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

/** administration 우선, 없으면 id 접미, 그것도 없으면 1/0 */
export function versionOf(item: Identifiable): VersionPair {
  const admin = item.administration;
  if (admin?.version && admin.revision) {
    return { version: admin.version, revision: admin.revision };
  }
  return versionFromId(item.id) ?? { version: '1', revision: '0' };
}

// ── 포인터로 대상 찾기 ────────────────────────────────────────────────────────

/** `/submodels/3/...` 처럼 최상위 배열의 N번째 항목을 꺼낸다 */
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

/** 값이 SubmodelElement인지 — modelType 문자열을 가진 객체면 그렇게 본다 */
export function asElement(value: unknown): SubmodelElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return typeof (value as { modelType?: unknown }).modelType === 'string'
    ? (value as SubmodelElement)
    : undefined;
}

// ── 참조 무결성 ──────────────────────────────────────────────────────────────

function isKey(value: unknown): value is Key {
  if (typeof value !== 'object' || value === null) return false;
  const k = value as { type?: unknown; value?: unknown };
  return typeof k.type === 'string' && typeof k.value === 'string';
}

/**
 * Environment 전역에서 oldId를 가리키는 Reference 키를 모두 newId로 바꾼다.
 * AAS의 submodels[] · semanticId · valueId · unitId · isCaseOf 모두 Reference이므로 한 번에 처리된다.
 * Identifiable 자신의 id 필드는 건드리지 않는다 — 호출부가 명시적으로 바꾼다.
 *
 * @returns 갱신한 키 개수
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

/** 이미 쓰이고 있는 id인지 — 교정으로 만든 새 id가 남의 id와 부딪히는 것을 막는다 */
export function idExists(env: Environment, id: string, except?: Identifiable): boolean {
  const all: Identifiable[] = [
    ...(env.assetAdministrationShells ?? []),
    ...(env.submodels ?? []),
    ...(env.conceptDescriptions ?? []),
  ];
  return all.some((item) => item !== except && item.id === id);
}

// ── ConceptDescription 생성 ──────────────────────────────────────────────────

/**
 * dataType 후보 중 하나를 고른다.
 * 단위가 없는데 *_MEASURE를 고르면 AASc-3a-009 위반을 새로 만들게 되므로,
 * 단위가 없으면 단위를 요구하지 않는 후보를 먼저 쓴다.
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

/** 요소의 성질에서 CD의 dataType을 유추한다. 값 해석을 창작하지 않는 범위에서만 */
export function inferDataType(node: SubmodelElement): DataTypeIec61360 {
  if (node.modelType === 'Property' || node.modelType === 'Range') {
    const candidates = XS_TO_DATA_TYPE[(node as Property).valueType];
    const picked = candidates ? pickDataType(candidates) : undefined;
    if (picked) return picked;
  }
  if (node.modelType === 'MultiLanguageProperty') return 'STRING_TRANSLATABLE';
  return 'STRING';
}

/** 골든 파일과 같은 형태의 IEC 61360 데이터 명세를 만든다 */
export function makeIec61360(idShort: string, dataType: DataTypeIec61360): DataSpecificationIec61360 {
  const label: LangString[] = [{ language: 'en', text: idShort }];
  return {
    modelType: 'DataSpecificationIec61360',
    preferredName: label,
    dataType,
    // 정의를 창작하지 않는다 — 골든 파일도 정의가 없는 항목은 idShort를 그대로 뒀다.
    // 사람이 개발계획서 원문으로 대체하는 것을 전제로 한 자리표시자다.
    definition: [{ language: 'en', text: idShort }],
  };
}

/** semanticId가 가리키는데 실물이 없는 ConceptDescription을 만든다 */
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
 * Environment 깊은 복사.
 *
 * structuredClone 대신 JSON 왕복을 쓴다 — 린터는 M3 저작 UI(브라우저)에서도 그대로 도는
 * 순수 로직이어야 해서 @types/node 전역에 기대지 않는다.
 * AAS Environment는 정의상 JSON 그 자체이므로(M2 canonicalJson 왕복으로 실증) 손실이 없다.
 */
export function cloneEnvironment(env: Environment): Environment {
  return JSON.parse(JSON.stringify(env)) as Environment;
}

// ── 그 밖 ───────────────────────────────────────────────────────────────────

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

/** 패키지 파트 중 썸네일로 쓸 이미지를 고른다. 이름에 thumbnail이 든 것을 우선한다 */
export function findThumbnailPart(parts: readonly string[]): string | undefined {
  const images = parts.filter((p) => extensionOf(p) in IMAGE_CONTENT_TYPES);
  return images.find((p) => /thumbnail/i.test(p)) ?? images[0];
}

/**
 * dataType → Property.valueType 역매핑.
 * XS_TO_DATA_TYPE의 반대 방향이며, 왕복이 성립하는 값만 담는다
 * (INTEGER_CURRENCY·RATIONAL·IRDI처럼 되돌아오지 않는 값은 일부러 뺐다 — 교정해도 수렴하지 않는다).
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

/** 왕복이 성립하는지 확인한 뒤 valueType을 돌려준다 */
export function valueTypeFor(dataType: string): DataTypeDefXsd | undefined {
  const xs = DATA_TYPE_TO_XS[dataType as DataTypeIec61360];
  if (!xs) return undefined;
  return XS_TO_DATA_TYPE[xs]?.includes(dataType) ? xs : undefined;
}
