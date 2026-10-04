/** 규칙 구현이 공통으로 쓰는 보조 함수 */
import type {
  ConceptDescription,
  DataSpecificationIec61360,
  LangString,
  Reference,
} from '@aas/core';
import type { LinterPolicy } from './policy.js';
import { IDTA_IRI_PREFIX } from './policy.js';

/** Reference의 첫 키 값. semanticId 비교에 쓴다 */
export function firstKeyValue(ref: Reference | undefined): string | undefined {
  const v = ref?.keys?.[0]?.value;
  return v !== undefined && v !== '' ? v : undefined;
}

/** KOSMO가 인정하는 id인지 — IRDI 또는 자체 IRI 접두 */
export function isAllowedId(value: string, policy: LinterPolicy): boolean {
  if (policy.irdiPrefixes.some((p) => value.startsWith(p))) return true;
  return value.startsWith(policy.iriBase + '/');
}

/** IDTA 공식 IRI인지 — 충돌 ① 판정용 */
export function isIdtaIri(value: string): boolean {
  return value.startsWith(IDTA_IRI_PREFIX);
}

/** CD의 IEC 61360 내용을 꺼낸다 (첫 번째 embeddedDataSpecification 기준) */
export function iec61360Of(cd: ConceptDescription): DataSpecificationIec61360 | undefined {
  for (const eds of cd.embeddedDataSpecifications ?? []) {
    const content = eds.dataSpecificationContent;
    if (content && content.modelType === 'DataSpecificationIec61360') {
      return content as DataSpecificationIec61360;
    }
  }
  return undefined;
}

/** 해당 언어 태그가 있는지 */
export function hasLanguage(strings: LangString[] | undefined, language: string): boolean {
  return (strings ?? []).some((s) => s.language === language && s.text.trim() !== '');
}

/** 중복 언어 태그를 찾는다 (PKG-LANG-DUP / AASd unique languages) */
export function duplicateLanguages(strings: LangString[] | undefined): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of strings ?? []) {
    if (seen.has(s.language)) dup.add(s.language);
    seen.add(s.language);
  }
  return [...dup];
}

/**
 * id의 끝 두 세그먼트를 돌려준다. KOSMO-AAS-3 / SM-2에서
 * administration.version·revision과 대조하는 데 쓴다.
 */
export function idVersionSuffix(id: string): string {
  const parts = id.split('/');
  return parts.slice(-2).join('/');
}

/** AASd-002 idShort 정규식 — 2자 이상, 영문 시작, 하이픈으로 끝날 수 없음 */
export const ID_SHORT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/;

export function isValidIdShort(idShort: string): boolean {
  return ID_SHORT_PATTERN.test(idShort);
}

/** valueType 대 dataType 매핑 (_kosmo_selfcheck.py의 XS_OK 이식) */
export const XS_TO_DATA_TYPE: Record<string, string[]> = {
  'xs:string': ['STRING', 'STRING_TRANSLATABLE'],
  'xs:anyURI': ['IRI'],
  'xs:date': ['DATE'],
  'xs:dateTime': ['TIMESTAMP', 'DATE'],
  'xs:time': ['TIME'],
  'xs:boolean': ['BOOLEAN'],
  'xs:int': ['INTEGER_COUNT', 'INTEGER_MEASURE'],
  'xs:integer': ['INTEGER_COUNT', 'INTEGER_MEASURE'],
  'xs:long': ['INTEGER_COUNT', 'INTEGER_MEASURE'],
  'xs:double': ['REAL_MEASURE', 'REAL_COUNT'],
  'xs:float': ['REAL_MEASURE', 'REAL_COUNT'],
  'xs:decimal': ['REAL_MEASURE', 'REAL_COUNT'],
};

/**
 * KOSMO가 허용하는 dataType 목록.
 * AASc-3a-004 열거보다 좁다 — FILE/BLOB/HTML은 KOSMO에서 거부된다(명세 §3).
 */
export const KOSMO_ALLOWED_DATA_TYPES = new Set([
  'DATE', 'STRING', 'STRING_TRANSLATABLE',
  'INTEGER_MEASURE', 'INTEGER_COUNT', 'INTEGER_CURRENCY',
  'REAL_MEASURE', 'REAL_COUNT', 'REAL_CURRENCY',
  'BOOLEAN', 'RATIONAL', 'RATIONAL_MEASURE', 'TIME', 'TIMESTAMP',
  'IRI', 'IRDI',
]);

/** AASc-3a-009 — 단위가 필요한 dataType */
export function needsUnit(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return dataType.endsWith('_MEASURE') || dataType.endsWith('_CURRENCY');
}

/** semanticId를 반드시 가져야 하는 요소 종류 (KOSMO-SME-3 대상 범위) */
export const SEMANTIC_REQUIRED_TYPES = new Set([
  'Property', 'MultiLanguageProperty', 'File', 'Blob', 'Range',
  'SubmodelElementCollection', 'SubmodelElementList',
  'Entity', 'RelationshipElement', 'AnnotatedRelationshipElement', 'ReferenceElement',
]);
