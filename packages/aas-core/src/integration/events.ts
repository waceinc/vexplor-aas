/**
 * Integration event catalogue and payload shapes (docs/design/integration-v1.md §2).
 *
 * This file is the contract the store, the detector, the projector, the delivery workers and the UI code against.
 * Changing a payload shape means a new `.v2` type, never an edit of a `.v1` shape — receivers in MES/ERP/CMMS parse these.
 *
 * Important: payloads are declared with `type`, not `interface`. A type alias has an implicit index signature, so a
 *    payload object can be stored as `StoredEvent.data` (`Record<string, unknown>`) without a cast; an interface cannot.
 * Important: browser-safe — no `node:` imports.
 */
import type { AssetKind, Reference } from '../types/common.js';
import type { MachineStateOrUnknown } from './states.js';

export const EVENT_TYPE_PREFIX = 'kr.vexplor.aas.';

export const EVENT_TYPES = {
  modelPackageCreated: 'kr.vexplor.aas.model.package.created.v1',
  modelPackageDeleted: 'kr.vexplor.aas.model.package.deleted.v1',
  modelPackageFileChanged: 'kr.vexplor.aas.model.package.file.changed.v1',
  modelShellCreated: 'kr.vexplor.aas.model.shell.created.v1',
  modelShellUpdated: 'kr.vexplor.aas.model.shell.updated.v1',
  modelShellDeleted: 'kr.vexplor.aas.model.shell.deleted.v1',
  modelSubmodelCreated: 'kr.vexplor.aas.model.submodel.created.v1',
  modelSubmodelUpdated: 'kr.vexplor.aas.model.submodel.updated.v1',
  modelSubmodelDeleted: 'kr.vexplor.aas.model.submodel.deleted.v1',
  modelConceptDescriptionCreated: 'kr.vexplor.aas.model.conceptdescription.created.v1',
  modelConceptDescriptionUpdated: 'kr.vexplor.aas.model.conceptdescription.updated.v1',
  modelConceptDescriptionDeleted: 'kr.vexplor.aas.model.conceptdescription.deleted.v1',
  modelExternalRefsUpdated: 'kr.vexplor.aas.model.externalrefs.updated.v1',
  equipmentMasterChanged: 'kr.vexplor.aas.equipment.master.changed.v1',
  equipmentBomChanged: 'kr.vexplor.aas.equipment.bom.changed.v1',
  equipmentMaintenanceChanged: 'kr.vexplor.aas.equipment.maintenance.changed.v1',
  equipmentDocumentsChanged: 'kr.vexplor.aas.equipment.documents.changed.v1',
  equipmentStateChanged: 'kr.vexplor.aas.equipment.state.changed.v1',
  equipmentAlarmRaised: 'kr.vexplor.aas.equipment.alarm.raised.v1',
  equipmentAlarmCleared: 'kr.vexplor.aas.equipment.alarm.cleared.v1',
  equipmentCounterAdvanced: 'kr.vexplor.aas.equipment.counter.advanced.v1',
  equipmentThresholdCrossed: 'kr.vexplor.aas.equipment.threshold.crossed.v1',
  equipmentThresholdReturned: 'kr.vexplor.aas.equipment.threshold.returned.v1',
  collectionConnectionLost: 'kr.vexplor.aas.collection.connection.lost.v1',
  collectionConnectionRestored: 'kr.vexplor.aas.collection.connection.restored.v1',
  integrationAudit: 'kr.vexplor.aas.integration.audit.v1',
  integrationPing: 'kr.vexplor.aas.integration.ping.v1',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export type EventClass = 'model' | 'projection' | 'runtime' | 'audit' | 'test';

/** Every type in catalogue order (§2.3) */
export const ALL_EVENT_TYPES: readonly EventType[] = Object.values(EVENT_TYPES);

/** Types that subscriptions may receive — audit is feed-only (admins), ping is sent directly and never stored */
export const DELIVERABLE_TYPES: readonly EventType[] = ALL_EVENT_TYPES.filter(
  (type) => type !== EVENT_TYPES.integrationAudit && type !== EVENT_TYPES.integrationPing,
);

export function isEventType(type: string): type is EventType {
  return (ALL_EVENT_TYPES as readonly string[]).includes(type);
}

export function isDeliverableType(type: string): boolean {
  return (DELIVERABLE_TYPES as readonly string[]).includes(type);
}

/** `kr.vexplor.aas.equipment.state.changed.v1` → `equipment.state.changed.v1` (MQTT topic tail, UI labels) */
export function shortEventType(type: string): string {
  return type.startsWith(EVENT_TYPE_PREFIX) ? type.slice(EVENT_TYPE_PREFIX.length) : type;
}

export function eventClassOf(type: string): EventClass | undefined {
  if (!isEventType(type)) return undefined;
  if (type === EVENT_TYPES.integrationAudit) return 'audit';
  if (type === EVENT_TYPES.integrationPing) return 'test';
  const name = shortEventType(type);
  if (name.startsWith('model.')) return 'model';
  if (/^equipment\.(master|bom|maintenance|documents)\./.test(name)) return 'projection';
  return 'runtime';
}

/**
 * One type filter against one type — exact, or a prefix ending in `*` (`equipment.*`, `*`).
 * A filter without the `kr.vexplor.aas.` prefix is read as if it had it, so `equipment.state.changed.v1` and the full
 * name are the same filter (people type the short form; the catalogue shows it).
 */
export function typeMatches(filter: string, type: string): boolean {
  const full = filter === '*' || filter.startsWith(EVENT_TYPE_PREFIX) ? filter : EVENT_TYPE_PREFIX + filter;
  if (full === '*') return true;
  if (full.endsWith('*')) return type.startsWith(full.slice(0, -1));
  return type === full;
}

/** A filter list — undefined or empty means "every type" */
export function typesMatch(filters: readonly string[] | undefined, type: string): boolean {
  if (filters === undefined || filters.length === 0) return true;
  return filters.some((filter) => typeMatches(filter, type));
}

/** `vxcause` values (§2.1) */
export const EVENT_CAUSES = ['edit', 'fix', 'import', 'undo', 'redo', 'derivation', 'external-refs', 'seed', 'system'] as const;
export type EventCause = (typeof EVENT_CAUSES)[number];

// ── Shared blocks inside `data` (§2.2) ─────────────────────────────────────────

export type Isa95Path = {
  enterprise?: string;
  site?: string;
  area?: string;
  workCenter?: string;
  workUnit?: string;
};

export type SpecificAssetIdPair = { name: string; value: string };
/** An external reference as it may appear in events and exports — never `sensitive`, never `costCenter` */
export type PublicExternalRef = { system: string; type: string; id: string };

/**
 * The `asset` join block. `globalAssetId` / `aasId` are null when the package has no AAS or the AAS has no global
 * asset id — events of such a package still go out (connection events), but receivers cannot join them.
 */
export type AssetJoin = {
  globalAssetId: string | null;
  aasId: string | null;
  packageId: string;
  assetKind: AssetKind | null;
  serialNumber: string | null;
  specificAssetIds: SpecificAssetIdPair[];
  externalRefs: PublicExternalRef[];
  path: string[];
  isa95: Isa95Path | null;
  /** Present (true) only when several process files reference this asset */
  pathAmbiguous?: true;
};

/** The `source` element block of runtime events */
export type ElementSource = {
  interfaceName: string;
  propertyName: string;
  /** Endpoint address with credentials masked */
  address: string;
  submodelId: string | null;
  idShortPath: string | null;
  semanticId: string | null;
  observableReference: Reference | null;
  simulated: boolean;
};

export type EventActor = { id: string; name: string };

// ── Model payloads ────────────────────────────────────────────────────────────

export type ModelPackageCreatedData = {
  packageId: string;
  name: string;
  owner: string | null;
  globalAssetId: string | null;
  aasId: string | null;
  counts: { AssetAdministrationShell: number; Submodel: number; ConceptDescription: number };
};

export type ModelPackageDeletedData = {
  packageId: string;
  name: string;
  globalAssetId: string | null;
  aasId: string | null;
};

export type ModelPackageFileChangedData = {
  packageId: string;
  part: string;
  role: string;
  operation: 'put' | 'delete';
};

export type ModelIdentifiableType = 'AssetAdministrationShell' | 'Submodel' | 'ConceptDescription';

export type ModelIdentifiableData = {
  packageId: string;
  modelType: ModelIdentifiableType;
  id: string;
  idShort: string | null;
  semanticId: string | null;
  operation: 'create' | 'update' | 'delete';
  identifiableRevision: number | null;
  packageRevision: number;
  globalAssetId: string | null;
  aasId: string | null;
  actor?: EventActor;
  /** Added by the renderer (derived from the row), never stored */
  links?: { self: string };
};

/**
 * The package's external-references sidecar was saved (revision = the sidecar's revision, not the package's).
 * Thin on purpose: refs can be sensitive or cost centres, so the event only says "re-read" — the projector picks the
 * change up from the log after a crash, consumers re-read the refs or the exports.
 */
export type ModelExternalRefsUpdatedData = {
  packageId: string;
  revision: number;
};

// ── Projection payloads ───────────────────────────────────────────────────────

export type ProjectionOperation = 'created' | 'updated' | 'removed';

export type EquipmentProjectionChangedData = {
  asset: AssetJoin;
  operation: ProjectionOperation;
  revision: number;
  projectionHash: string;
  href: string;
};

export type EquipmentMasterChangedData = EquipmentProjectionChangedData & {
  /** Sorted column keys (EQUIPMENT_V1_COLUMNS) whose value differs from the previous projection */
  changedKeys: string[];
};

// ── Runtime payloads ──────────────────────────────────────────────────────────

export type EquipmentStateChangedData = {
  asset: AssetJoin;
  source: ElementSource;
  state: MachineStateOrUnknown;
  previousState: MachineStateOrUnknown | null;
  previousStateSince: string | null;
  previousDurationMs: number | null;
  rawValue: string | null;
  ruleSetHash: string;
  observedAt: string;
  receivedAt: string | null;
  quality: string | null;
  detectionResolutionMs: number;
  suppressed: boolean;
};

export type EquipmentAlarmData = {
  asset: AssetJoin;
  source: ElementSource;
  alarmRuleId: string;
  alarmInstanceId: string;
  code: string | null;
  text: string | null;
  severity: string | null;
  raisedAt: string;
  detectedAt: string;
  clearedAt: string | null;
  durationMs: number | null;
  occurrences: number;
  maintenanceIds: string[];
  detectionResolutionMs: number;
  suppressed: boolean;
};

export const COUNTER_KINDS = ['total', 'good', 'reject', 'runHours', 'energy', 'other'] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];

export type CounterFlags = { reset: boolean; rollover: boolean; implausible: boolean; gap: boolean };

export type EquipmentCounterAdvancedData = {
  asset: AssetJoin;
  source: ElementSource;
  counterId: string;
  counterKind: CounterKind;
  unit: string | null;
  from: number;
  to: number;
  /** null after a reset without a configured max, or when the rate is implausible (never guessed) */
  delta: number | null;
  intervalStart: string;
  intervalEnd: string;
  flags: CounterFlags;
  excludedBadSamples: number;
};

export type ThresholdDirection = 'above' | 'below';

export type EquipmentThresholdData = {
  asset: AssetJoin;
  source: ElementSource;
  thresholdId: string;
  direction: ThresholdDirection;
  limit: number;
  hysteresis: number;
  value: number;
  unit: string | null;
  severity: string | null;
  observedAt: string;
  detectedAt: string;
  suppressed: boolean;
};

export type CollectionConnectionData = {
  asset: AssetJoin;
  interfaceName: string;
  protocol: string;
  /** Credentials masked */
  endpoint: string;
  error: string | null;
  since: string;
  consecutiveFailures: number;
  simulated: boolean;
};

// ── Audit and ping ────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS = [
  'subscription.created',
  'subscription.updated',
  'subscription.deleted',
  'subscription.secret-rotated',
  'subscription.replayed',
  'delivery.redelivered',
  'external-refs.imported',
  'config.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type IntegrationAuditData = {
  action: AuditAction;
  target: string;
  actor?: EventActor;
  /** Never secrets, never URLs with credentials */
  details: Record<string, unknown>;
};

export type IntegrationPingData = {
  subscriptionId: string;
  serverTime: string;
  message: string;
};

/** Payload per type — lets producers write `data: EventDataOf<typeof EVENT_TYPES.equipmentStateChanged>` */
export type EventDataMap = {
  [EVENT_TYPES.modelPackageCreated]: ModelPackageCreatedData;
  [EVENT_TYPES.modelPackageDeleted]: ModelPackageDeletedData;
  [EVENT_TYPES.modelPackageFileChanged]: ModelPackageFileChangedData;
  [EVENT_TYPES.modelShellCreated]: ModelIdentifiableData;
  [EVENT_TYPES.modelShellUpdated]: ModelIdentifiableData;
  [EVENT_TYPES.modelShellDeleted]: ModelIdentifiableData;
  [EVENT_TYPES.modelSubmodelCreated]: ModelIdentifiableData;
  [EVENT_TYPES.modelSubmodelUpdated]: ModelIdentifiableData;
  [EVENT_TYPES.modelSubmodelDeleted]: ModelIdentifiableData;
  [EVENT_TYPES.modelConceptDescriptionCreated]: ModelIdentifiableData;
  [EVENT_TYPES.modelConceptDescriptionUpdated]: ModelIdentifiableData;
  [EVENT_TYPES.modelConceptDescriptionDeleted]: ModelIdentifiableData;
  [EVENT_TYPES.modelExternalRefsUpdated]: ModelExternalRefsUpdatedData;
  [EVENT_TYPES.equipmentMasterChanged]: EquipmentMasterChangedData;
  [EVENT_TYPES.equipmentBomChanged]: EquipmentProjectionChangedData;
  [EVENT_TYPES.equipmentMaintenanceChanged]: EquipmentProjectionChangedData;
  [EVENT_TYPES.equipmentDocumentsChanged]: EquipmentProjectionChangedData;
  [EVENT_TYPES.equipmentStateChanged]: EquipmentStateChangedData;
  [EVENT_TYPES.equipmentAlarmRaised]: EquipmentAlarmData;
  [EVENT_TYPES.equipmentAlarmCleared]: EquipmentAlarmData;
  [EVENT_TYPES.equipmentCounterAdvanced]: EquipmentCounterAdvancedData;
  [EVENT_TYPES.equipmentThresholdCrossed]: EquipmentThresholdData;
  [EVENT_TYPES.equipmentThresholdReturned]: EquipmentThresholdData;
  [EVENT_TYPES.collectionConnectionLost]: CollectionConnectionData;
  [EVENT_TYPES.collectionConnectionRestored]: CollectionConnectionData;
  [EVENT_TYPES.integrationAudit]: IntegrationAuditData;
  [EVENT_TYPES.integrationPing]: IntegrationPingData;
};
export type EventDataOf<T extends EventType> = EventDataMap[T];

/**
 * The rendered CloudEvents 1.0 structured envelope (§2.1). Rendering lives in the API (`integration/cloudevents.ts`);
 * the shape is here so the web client and tests can type what the pull feed returns.
 */
export type CloudEvent<D = Record<string, unknown>> = {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  datacontenttype: 'application/json';
  dataschema?: string;
  /** Store sequence, zero-padded to 20 digits (the CloudEvents sequence extension is a string) */
  sequence: string;
  vxpackageid?: string;
  vxrevision?: number;
  vxcause?: string;
  vxchangeset?: string;
  data: D;
};
