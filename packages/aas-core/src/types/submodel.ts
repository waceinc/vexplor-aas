/**
 * Submodel 및 SubmodelElement 14종.
 *
 * 각 타입은 JSON의 modelType 판별자를 필수로 갖는다 — 역직렬화 시 판별 유니온으로 쓰기 위함.
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
  contentType: string;
  /** base64 인코딩 */
  value?: string;
}

export interface File extends SubmodelElementBase {
  modelType: 'File';
  contentType: string;
  /** PKG-FILE-URI: file:// URI 형식이어야 한다 (단순 상대경로는 스키마 위반) */
  value?: string;
}

export interface ReferenceElement extends SubmodelElementBase {
  modelType: 'ReferenceElement';
  value?: Reference;
}

export interface RelationshipElement extends SubmodelElementBase {
  modelType: 'RelationshipElement';
  first: Reference;
  second: Reference;
}

export interface AnnotatedRelationshipElement extends SubmodelElementBase {
  modelType: 'AnnotatedRelationshipElement';
  first: Reference;
  second: Reference;
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
  /** AASd-108 — 직계 자식은 모두 이 타입이어야 한다 */
  typeValueListElement: AasSubmodelElementType;
  orderRelevant?: boolean;
  /** AASd-107 / AASd-114 — 직계 자식의 semanticId는 이 값과 일치해야 한다 */
  semanticIdListElement?: Reference;
  /** AASd-109 — 자식이 Property/Range면 필수 */
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
  entityType: EntityType;
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

/** SubmodelElement 판별 유니온 */
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
  /** KOSMO-SM-4: Template 이어야 한다 */
  kind?: ModellingKind;
  submodelElements?: SubmodelElement[];
}
