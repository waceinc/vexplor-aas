/**
 * ConceptDescription 및 IEC 61360 데이터 명세.
 *
 * 골든 파일 실측: CD는 embeddedDataSpecifications[0].dataSpecificationContent에
 * DataSpecificationIec61360을 담는 형태만 사용한다.
 */
import type {
  EmbeddedDataSpecification,
  HasDataSpecification,
  Identifiable,
  LangString,
  Reference,
} from './common.js';

/** DataTypeIec61360 — 스펙 전체 열거값 */
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
  /** AASc-3a-002: 영문 필수 */
  preferredName: LangString[];
  shortName?: LangString[];
  unit?: string;
  /** AASc-3a-009: dataType이 *_MEASURE / *_CURRENCY면 unit 또는 unitId 필수 */
  unitId?: Reference;
  sourceOfDefinition?: string;
  symbol?: string;
  dataType?: DataTypeIec61360;
  /** AASc-3a-008 = KOSMO-CD-3: 영문 definition 필수 */
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

/** IEC 61360 데이터 명세 템플릿의 공식 IRI */
export const IEC61360_TEMPLATE_IRI =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';
