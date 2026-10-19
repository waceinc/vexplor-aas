/**
 * Submodel and the 14 SubmodelElement types.
 *
 * Every type has a required modelType discriminator from the JSON - used as a discriminated union during deserialization.
 */
import type {
  AasSubmodelElementType,
  DataTypeDefXsd,
  Direction,
  EntityType,
  HasDataSpecification,
  HasSemantics,
  Identifiable,
  LangString,
  ModellingKind,
  Qualifiable,
  Referable,
  Reference,
  StateOfEvent,
} from './common.js';

export interface SubmodelElementBase
  extends Referable, HasSemantics, Qualifiable, HasDataSpecification {
  modelType: AasSubmodelElementType;
}

export interface Property extends SubmodelElementBase {
  modelType: 'Property';
  valueType: DataTypeDefXsd;
  value?: string;
  valueId?: Reference;
}

export interface MultiLanguageProperty extends SubmodelElementBase {
  modelType: 'MultiLanguageProperty';
  value?: LangString[];
  valueId?: Reference;
}

export interface Range extends SubmodelElementBase {
  modelType: 'Range';
  valueType: DataTypeDefXsd;
  min?: string;
  max?: string;
}

export interface Blob extends SubmodelElementBase {
  modelType: 'Blob';
  /** Required in V3.0, optional from V3.1 */
  contentType?: string;
  /** base64 encoded */
  value?: string;
}

export interface File extends SubmodelElementBase {
  modelType: 'File';
  /** Required in V3.0, optional from V3.1 */
  contentType?: string;
  /** PKG-FILE-URI: must be a file:// URI (a bare relative path violates the schema) */
  value?: string;
}

export interface ReferenceElement extends SubmodelElementBase {
  modelType: 'ReferenceElement';
  value?: Reference;
}

export interface RelationshipElement extends SubmodelElementBase {
  modelType: 'RelationshipElement';
  /** Required in V3.0, optional from V3.1 */
  first?: Reference;
  /** Required in V3.0, optional from V3.1 */
  second?: Reference;
}

export interface AnnotatedRelationshipElement extends SubmodelElementBase {
  modelType: 'AnnotatedRelationshipElement';
  /** Required in V3.0, optional from V3.1 */
  first?: Reference;
  /** Required in V3.0, optional from V3.1 */
  second?: Reference;
  annotations?: SubmodelElement[];
}

export interface Capability extends SubmodelElementBase {
  modelType: 'Capability';
}

export interface SubmodelElementCollection extends SubmodelElementBase {
  modelType: 'SubmodelElementCollection';
  value?: SubmodelElement[];
}

export interface SubmodelElementList extends SubmodelElementBase {
  modelType: 'SubmodelElementList';
  /** AASd-108 - all direct children must be of this type */
  typeValueListElement: AasSubmodelElementType;
  orderRelevant?: boolean;
  /** AASd-107 / AASd-114 - the semanticId of direct children must match this value */
  semanticIdListElement?: Reference;
  /** AASd-109 - required if the children are Property/Range */
  valueTypeListElement?: DataTypeDefXsd;
  value?: SubmodelElement[];
}

export interface SpecificAssetId extends HasSemantics {
  name: string;
  value: string;
  externalSubjectId?: Reference;
}

export interface Entity extends SubmodelElementBase {
  modelType: 'Entity';
  /** Required in V3.0, optional from V3.1 (AASd-014 relaxed) */
  entityType?: EntityType;
  statements?: SubmodelElement[];
  globalAssetId?: string;
  specificAssetIds?: SpecificAssetId[];
}

export interface OperationVariable {
  value: SubmodelElement;
}

export interface Operation extends SubmodelElementBase {
  modelType: 'Operation';
  inputVariables?: OperationVariable[];
  outputVariables?: OperationVariable[];
  inoutputVariables?: OperationVariable[];
}

export interface EventPayload {
  source: Reference;
  sourceSemanticId?: Reference;
  observableReference: Reference;
  observableSemanticId?: Reference;
  topic?: string;
  subjectId?: Reference;
  timeStamp: string;
  payload?: string;
}

export interface BasicEventElement extends SubmodelElementBase {
  modelType: 'BasicEventElement';
  observed: Reference;
  direction: Direction;
  state: StateOfEvent;
  messageTopic?: string;
  messageBroker?: Reference;
  lastUpdate?: string;
  minInterval?: string;
  maxInterval?: string;
}

/** SubmodelElement discriminated union */
export type SubmodelElement =
  | Property
  | MultiLanguageProperty
  | Range
  | Blob
  | File
  | ReferenceElement
  | RelationshipElement
  | AnnotatedRelationshipElement
  | Capability
  | SubmodelElementCollection
  | SubmodelElementList
  | Entity
  | Operation
  | BasicEventElement;

export interface Submodel extends Identifiable, HasSemantics, Qualifiable, HasDataSpecification {
  modelType: 'Submodel';
  /** KOSMO-SM-4: must be Template */
  kind?: ModellingKind;
  submodelElements?: SubmodelElement[];
}
