/** Helper functions shared by rule implementations */
import type {
  ConceptDescription,
  DataSpecificationIec61360,
  LangString,
  Reference,
} from '@aas/core';
import type { LinterPolicy } from './policy.js';
import { IDTA_IRI_PREFIX } from './policy.js';

/** Value of a Reference's first key. Used for semanticId comparison */
export function firstKeyValue(ref: Reference | undefined): string | undefined {
  const v = ref?.keys?.[0]?.value;
  return v !== undefined && v !== '' ? v : undefined;
}

/** Whether the id is accepted by KOSMO — IRDI or an own-IRI prefix */
export function isAllowedId(value: string, policy: LinterPolicy): boolean {
  if (policy.irdiPrefixes.some((p) => value.startsWith(p))) return true;
  return value.startsWith(policy.iriBase + '/');
}

/** Whether this is an official IDTA IRI — for deciding conflict ① */
export function isIdtaIri(value: string): boolean {
  return value.startsWith(IDTA_IRI_PREFIX);
}

/** Extract a CD's IEC 61360 content (based on the first embeddedDataSpecification) */
export function iec61360Of(cd: ConceptDescription): DataSpecificationIec61360 | undefined {
  for (const eds of cd.embeddedDataSpecifications ?? []) {
    const content = eds.dataSpecificationContent;
    if (content && content.modelType === 'DataSpecificationIec61360') {
      return content as DataSpecificationIec61360;
    }
  }
  return undefined;
}

/** Whether the given language tag is present */
export function hasLanguage(strings: LangString[] | undefined, language: string): boolean {
  return (strings ?? []).some((s) => s.language === language && s.text.trim() !== '');
}

/** Find duplicate language tags (PKG-LANG-DUP / AASd unique languages) */
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
 * Returns the last two segments of an id. Used in KOSMO-AAS-3 / SM-2
 * to compare against administration.version·revision.
 */
export function idVersionSuffix(id: string): string {
  const parts = id.split('/');
  return parts.slice(-2).join('/');
}

/** AASd-002 idShort regex — at least 2 characters, starts with a letter, cannot end with a hyphen */
export const ID_SHORT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/;

export function isValidIdShort(idShort: string): boolean {
  return ID_SHORT_PATTERN.test(idShort);
}

/** valueType to dataType mapping (port of XS_OK from _kosmo_selfcheck.py) */
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
 * dataTypes allowed by KOSMO.
 * Narrower than the AASc-3a-004 enumeration — FILE/BLOB/HTML are rejected by KOSMO (spec §3).
 */
export const KOSMO_ALLOWED_DATA_TYPES = new Set([
  'DATE', 'STRING', 'STRING_TRANSLATABLE',
  'INTEGER_MEASURE', 'INTEGER_COUNT', 'INTEGER_CURRENCY',
  'REAL_MEASURE', 'REAL_COUNT', 'REAL_CURRENCY',
  'BOOLEAN', 'RATIONAL', 'RATIONAL_MEASURE', 'TIME', 'TIMESTAMP',
  'IRI', 'IRDI',
]);

/** AASc-3a-009 — dataTypes that require a unit */
export function needsUnit(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return dataType.endsWith('_MEASURE') || dataType.endsWith('_CURRENCY');
}

/** Element kinds that must have a semanticId (KOSMO-SME-3 scope) */
export const SEMANTIC_REQUIRED_TYPES = new Set([
  'Property', 'MultiLanguageProperty', 'File', 'Blob', 'Range',
  'SubmodelElementCollection', 'SubmodelElementList',
  'Entity', 'RelationshipElement', 'AnnotatedRelationshipElement', 'ReferenceElement',
]);
