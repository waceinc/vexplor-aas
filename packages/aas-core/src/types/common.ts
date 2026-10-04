/**
 * AAS V3.0 (IEC 63278-1) 공통 타입.
 *
 * 열거값은 스펙 원문 표기를 그대로 쓴다. JSON 직렬화 시 값이 곧 문자열이므로
 * TypeScript enum 대신 문자열 리터럴 유니온 + 런타임 배열 쌍으로 정의한다.
 */

/** KeyTypes — Reference 키의 대상 종류 */
export const KEY_TYPES = [
  'AnnotatedRelationshipElement',
  'AssetAdministrationShell',
  'BasicEventElement',
  'Blob',
  'Capability',
  'ConceptDescription',
  'DataElement',
  'Entity',
  'EventElement',
  'File',
  'FragmentReference',
  'GlobalReference',
  'Identifiable',
  'MultiLanguageProperty',
  'Operation',
  'Property',
  'Range',
  'Referable',
  'ReferenceElement',
  'RelationshipElement',
  'Submodel',
  'SubmodelElement',
  'SubmodelElementCollection',
  'SubmodelElementList',
] as const;
export type KeyType = (typeof KEY_TYPES)[number];

/** AASd-121 — Reference 첫 키로 허용되는 GloballyIdentifiable */
export const GLOBALLY_IDENTIFIABLE: readonly KeyType[] = [
  'AssetAdministrationShell',
  'ConceptDescription',
  'GlobalReference',
  'Identifiable',
  'Submodel',
];

export const REFERENCE_TYPES = ['ExternalReference', 'ModelReference'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/** DataTypeDefXsd — Property.valueType 허용값 */
export const DATA_TYPE_DEF_XSD = [
  'xs:anyURI', 'xs:base64Binary', 'xs:boolean', 'xs:byte', 'xs:date', 'xs:dateTime',
  'xs:decimal', 'xs:double', 'xs:duration', 'xs:float', 'xs:gDay', 'xs:gMonth',
  'xs:gMonthDay', 'xs:gYear', 'xs:gYearMonth', 'xs:hexBinary', 'xs:int', 'xs:integer',
  'xs:long', 'xs:negativeInteger', 'xs:nonNegativeInteger', 'xs:nonPositiveInteger',
  'xs:positiveInteger', 'xs:short', 'xs:string', 'xs:time', 'xs:unsignedByte',
  'xs:unsignedInt', 'xs:unsignedLong', 'xs:unsignedShort',
] as const;
export type DataTypeDefXsd = (typeof DATA_TYPE_DEF_XSD)[number];

export const ASSET_KINDS = ['Type', 'Instance', 'NotApplicable'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const MODELLING_KINDS = ['Template', 'Instance'] as const;
export type ModellingKind = (typeof MODELLING_KINDS)[number];

export const ENTITY_TYPES = ['CoManagedEntity', 'SelfManagedEntity'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const QUALIFIER_KINDS = ['ValueQualifier', 'ConceptQualifier', 'TemplateQualifier'] as const;
export type QualifierKind = (typeof QUALIFIER_KINDS)[number];

export const DIRECTIONS = ['input', 'output'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const STATES_OF_EVENT = ['on', 'off'] as const;
export type StateOfEvent = (typeof STATES_OF_EVENT)[number];

/** AasSubmodelElements — SubmodelElementList.typeValueListElement 등에 쓰인다 */
export const AAS_SUBMODEL_ELEMENTS = [
  'AnnotatedRelationshipElement', 'BasicEventElement', 'Blob', 'Capability',
  'DataElement', 'Entity', 'EventElement', 'File', 'MultiLanguageProperty',
  'Operation', 'Property', 'Range', 'ReferenceElement', 'RelationshipElement',
  'SubmodelElement', 'SubmodelElementCollection', 'SubmodelElementList',
] as const;
export type AasSubmodelElementType = (typeof AAS_SUBMODEL_ELEMENTS)[number];

// ─────────────────────────────────────────────────────────────────────────────

export interface Key {
  type: KeyType;
  value: string;
}

export interface Reference {
  type: ReferenceType;
  keys: Key[];
  referredSemanticId?: Reference;
}

export interface LangString {
  language: string;
  text: string;
}

export interface AdministrativeInformation {
  version?: string;
  revision?: string;
  creator?: Reference;
  templateId?: string;
  embeddedDataSpecifications?: EmbeddedDataSpecification[];
}

export interface Extension {
  name: string;
  semanticId?: Reference;
  supplementalSemanticIds?: Reference[];
  valueType?: DataTypeDefXsd;
  value?: string;
  refersTo?: Reference[];
}

export interface Qualifier {
  type: string;
  valueType: DataTypeDefXsd;
  kind?: QualifierKind;
  semanticId?: Reference;
  supplementalSemanticIds?: Reference[];
  value?: string;
  valueId?: Reference;
}

/** 구체 내용은 concept.ts의 DataSpecificationIec61360 — 순환 참조를 피해 여기서는 느슨하게 둔다 */
export interface EmbeddedDataSpecification {
  dataSpecification: Reference;
  dataSpecificationContent: DataSpecificationContent;
}

export interface DataSpecificationContent {
  modelType: string;
}

/** Referable — idShort를 갖는 모든 요소의 공통 상위 */
export interface Referable {
  idShort?: string;
  category?: string;
  displayName?: LangString[];
  description?: LangString[];
  extensions?: Extension[];
}

/** Identifiable — 전역 id를 갖는 최상위 3종(AAS · Submodel · ConceptDescription) */
export interface Identifiable extends Referable {
  id: string;
  administration?: AdministrativeInformation;
}

/** HasSemantics */
export interface HasSemantics {
  semanticId?: Reference;
  supplementalSemanticIds?: Reference[];
}

/** Qualifiable */
export interface Qualifiable {
  qualifiers?: Qualifier[];
}

/** HasDataSpecification */
export interface HasDataSpecification {
  embeddedDataSpecifications?: EmbeddedDataSpecification[];
}
