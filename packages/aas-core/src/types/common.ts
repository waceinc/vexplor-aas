/**
 * AAS V3.0 (IEC 63278-1) common types.
 *
 * Enumeration values use the spec's original notation verbatim. Since the value itself is the string in JSON serialization,
 * they are defined as string literal unions + runtime arrays instead of TypeScript enums.
 */

/** KeyTypes — the kind of target of a Reference key */
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

/** AASd-121 — GloballyIdentifiables allowed as the first key of a Reference */
export const GLOBALLY_IDENTIFIABLE: readonly KeyType[] = [
  'AssetAdministrationShell',
  'ConceptDescription',
  'GlobalReference',
  'Identifiable',
  'Submodel',
];

export const REFERENCE_TYPES = ['ExternalReference', 'ModelReference'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/** DataTypeDefXsd — allowed values of Property.valueType */
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

/** AasSubmodelElements — used by SubmodelElementList.typeValueListElement and others */
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

/** The concrete content is DataSpecificationIec61360 in concept.ts — kept loose here to avoid a circular reference */
export interface EmbeddedDataSpecification {
  dataSpecification: Reference;
  dataSpecificationContent: DataSpecificationContent;
}

export interface DataSpecificationContent {
  modelType: string;
}

/** Referable — common supertype of every element that has an idShort */
export interface Referable {
  idShort?: string;
  category?: string;
  displayName?: LangString[];
  description?: LangString[];
  extensions?: Extension[];
}

/** Identifiable — the 3 top-level kinds with a global id (AAS · Submodel · ConceptDescription) */
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
