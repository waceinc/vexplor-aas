/**
 * ConceptDescription and the IEC 61360 data specification.
 *
 * Measured on golden files: CDs only use the form where embeddedDataSpecifications[0].dataSpecificationContent
 * holds a DataSpecificationIec61360.
 */
import type {
  EmbeddedDataSpecification,
  HasDataSpecification,
  Identifiable,
  LangString,
  Reference,
} from './common.js';

/** DataTypeIec61360 — the spec's full enumeration */
export const DATA_TYPE_IEC61360 = [
  'DATE', 'STRING', 'STRING_TRANSLATABLE', 'INTEGER_MEASURE', 'INTEGER_COUNT',
  'INTEGER_CURRENCY', 'REAL_MEASURE', 'REAL_COUNT', 'REAL_CURRENCY', 'BOOLEAN',
  'IRI', 'IRDI', 'RATIONAL', 'RATIONAL_MEASURE', 'TIME', 'TIMESTAMP',
  'FILE', 'HTML', 'BLOB',
] as const;
export type DataTypeIec61360 = (typeof DATA_TYPE_IEC61360)[number];

export const LEVEL_TYPE_KEYS = ['min', 'nom', 'typ', 'max'] as const;
export type LevelTypeKey = (typeof LEVEL_TYPE_KEYS)[number];

export type LevelType = Record<LevelTypeKey, boolean>;

export interface ValueReferencePair {
  value: string;
  valueId: Reference;
}

export interface ValueList {
  valueReferencePairs: ValueReferencePair[];
}

export interface DataSpecificationIec61360 {
  modelType: 'DataSpecificationIec61360';
  /** AASc-3a-002: English required */
  preferredName: LangString[];
  shortName?: LangString[];
  unit?: string;
  /** AASc-3a-009: if dataType is *_MEASURE / *_CURRENCY, unit or unitId is required */
  unitId?: Reference;
  sourceOfDefinition?: string;
  symbol?: string;
  dataType?: DataTypeIec61360;
  /** AASc-3a-008 = KOSMO-CD-3: English definition required */
  definition?: LangString[];
  valueFormat?: string;
  valueList?: ValueList;
  value?: string;
  levelType?: LevelType;
}

export interface Iec61360EmbeddedDataSpecification extends EmbeddedDataSpecification {
  dataSpecificationContent: DataSpecificationIec61360;
}

export interface ConceptDescription extends Identifiable, HasDataSpecification {
  modelType: 'ConceptDescription';
  isCaseOf?: Reference[];
}

/** Official IRI of the IEC 61360 data specification template */
export const IEC61360_TEMPLATE_IRI =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';
