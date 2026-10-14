/**
 * JSON Schemas of the event envelope and of every event type's `data` (docs/design/integration-v1.md §2.5).
 *
 * Served at `GET /integrations/schemas[/:type]` and referenced by `dataschema`. A CI test validates every event the
 * test scenarios produce against these (schema-check.ts), so a producer that drifts from the contract fails CI
 * instead of a customer's MES.
 * Important: data schemas are closed (`additionalProperties: false`). An extra field is either a contract change
 *    (new `.v2` type, docs) or a leak (content, secrets) — both must be noticed.
 */
import { ALL_EVENT_TYPES, ASSET_KINDS, AUDIT_ACTIONS, COUNTER_KINDS, EVENT_TYPES, EVENT_CAUSES, MACHINE_STATES, type EventType } from '@aas/core';

import type { JsonSchema, SchemaType } from './schema-check.js';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const str: JsonSchema = { type: 'string' };
const int: JsonSchema = { type: 'integer' };
const num: JsonSchema = { type: 'number' };
const bool: JsonSchema = { type: 'boolean' };
const nullable = (type: SchemaType): JsonSchema => ({ type: [type, 'null'] });
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

/** A closed object — every listed property required unless named in `optional` */
function object(properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  };
}

const STATES = [...MACHINE_STATES, 'unknown'];

const DEFS: Record<string, JsonSchema> = {
  asset: object(
    {
      globalAssetId: nullable('string'),
      aasId: nullable('string'),
      packageId: str,
      assetKind: { type: ['string', 'null'], enum: [...ASSET_KINDS, null] },
      serialNumber: nullable('string'),
      specificAssetIds: list(object({ name: str, value: str })),
      externalRefs: list(object({ system: str, type: str, id: str })),
      path: list(str),
      isa95: {
        type: ['object', 'null'],
        properties: { enterprise: str, site: str, area: str, workCenter: str, workUnit: str },
        additionalProperties: false,
      },
      pathAmbiguous: { const: true },
    },
    ['pathAmbiguous'],
  ),
  reference: {
    type: 'object',
    properties: { type: str, keys: list(object({ type: str, value: str })) },
    required: ['type', 'keys'],
  },
  source: object({
    interfaceName: str,
    propertyName: str,
    address: str,
    submodelId: nullable('string'),
    idShortPath: nullable('string'),
    semanticId: nullable('string'),
    observableReference: { anyOf: [ref('reference'), { type: 'null' }] },
    simulated: bool,
  }),
  actor: object({ id: str, name: str }),
};

const modelIdentifiable = object(
  {
    packageId: str,
    modelType: { type: 'string', enum: ['AssetAdministrationShell', 'Submodel', 'ConceptDescription'] },
    id: str,
    idShort: nullable('string'),
    semanticId: nullable('string'),
    operation: { type: 'string', enum: ['create', 'update', 'delete'] },
    identifiableRevision: nullable('integer'),
    packageRevision: int,
    globalAssetId: nullable('string'),
    aasId: nullable('string'),
    actor: ref('actor'),
    links: object({ self: str }),
  },
  ['actor', 'links'],
);

const projection = (extra: Record<string, JsonSchema> = {}): JsonSchema =>
  object({
    asset: ref('asset'),
    operation: { type: 'string', enum: ['created', 'updated', 'removed'] },
    revision: int,
    projectionHash: str,
    href: str,
    ...extra,
  });

const alarm = object({
  asset: ref('asset'),
  source: ref('source'),
  alarmRuleId: str,
  alarmInstanceId: str,
  code: nullable('string'),
  text: nullable('string'),
  severity: nullable('string'),
  raisedAt: str,
  detectedAt: str,
  clearedAt: nullable('string'),
  durationMs: nullable('number'),
  occurrences: int,
  maintenanceIds: list(str),
  detectionResolutionMs: num,
  suppressed: bool,
});

const threshold = object({
  asset: ref('asset'),
  source: ref('source'),
  thresholdId: str,
  direction: { type: 'string', enum: ['above', 'below'] },
  limit: num,
  hysteresis: num,
  value: num,
  unit: nullable('string'),
  severity: nullable('string'),
  observedAt: str,
  detectedAt: str,
  suppressed: bool,
});

const connection = object({
  asset: ref('asset'),
  interfaceName: str,
  protocol: str,
  endpoint: str,
  error: nullable('string'),
  since: str,
  consecutiveFailures: int,
  simulated: bool,
});

const DATA: Record<EventType, JsonSchema> = {
  [EVENT_TYPES.modelPackageCreated]: object({
    packageId: str,
    name: str,
    owner: nullable('string'),
    globalAssetId: nullable('string'),
    aasId: nullable('string'),
    counts: object({ AssetAdministrationShell: int, Submodel: int, ConceptDescription: int }),
  }),
  [EVENT_TYPES.modelPackageDeleted]: object({ packageId: str, name: str, globalAssetId: nullable('string'), aasId: nullable('string') }),
  [EVENT_TYPES.modelPackageFileChanged]: object({ packageId: str, part: str, role: str, operation: { type: 'string', enum: ['put', 'delete'] } }),
  [EVENT_TYPES.modelShellCreated]: modelIdentifiable,
  [EVENT_TYPES.modelShellUpdated]: modelIdentifiable,
  [EVENT_TYPES.modelShellDeleted]: modelIdentifiable,
  [EVENT_TYPES.modelSubmodelCreated]: modelIdentifiable,
  [EVENT_TYPES.modelSubmodelUpdated]: modelIdentifiable,
  [EVENT_TYPES.modelSubmodelDeleted]: modelIdentifiable,
  [EVENT_TYPES.modelConceptDescriptionCreated]: modelIdentifiable,
  [EVENT_TYPES.modelConceptDescriptionUpdated]: modelIdentifiable,
  [EVENT_TYPES.modelConceptDescriptionDeleted]: modelIdentifiable,
  [EVENT_TYPES.equipmentMasterChanged]: projection({ changedKeys: list(str) }),
  [EVENT_TYPES.equipmentBomChanged]: projection(),
  [EVENT_TYPES.equipmentMaintenanceChanged]: projection(),
  [EVENT_TYPES.equipmentDocumentsChanged]: projection(),
  [EVENT_TYPES.equipmentStateChanged]: object({
    asset: ref('asset'),
    source: ref('source'),
    state: { type: 'string', enum: STATES },
    previousState: { type: ['string', 'null'], enum: [...STATES, null] },
    previousStateSince: nullable('string'),
    previousDurationMs: nullable('number'),
    rawValue: nullable('string'),
    ruleSetHash: str,
    observedAt: str,
    receivedAt: nullable('string'),
    quality: nullable('string'),
    detectionResolutionMs: num,
    suppressed: bool,
  }),
  [EVENT_TYPES.equipmentAlarmRaised]: alarm,
  [EVENT_TYPES.equipmentAlarmCleared]: alarm,
  [EVENT_TYPES.equipmentCounterAdvanced]: object({
    asset: ref('asset'),
    source: ref('source'),
    counterId: str,
    counterKind: { type: 'string', enum: [...COUNTER_KINDS] },
    unit: nullable('string'),
    from: num,
    to: num,
    delta: nullable('number'),
    intervalStart: str,
    intervalEnd: str,
    flags: object({ reset: bool, rollover: bool, implausible: bool, gap: bool }),
    excludedBadSamples: int,
  }),
  [EVENT_TYPES.equipmentThresholdCrossed]: threshold,
  [EVENT_TYPES.equipmentThresholdReturned]: threshold,
  [EVENT_TYPES.collectionConnectionLost]: connection,
  [EVENT_TYPES.collectionConnectionRestored]: connection,
  [EVENT_TYPES.integrationAudit]: object(
    {
      action: { type: 'string', enum: [...AUDIT_ACTIONS] },
      target: str,
      actor: ref('actor'),
      details: { type: 'object' },
    },
    ['actor'],
  ),
  [EVENT_TYPES.integrationPing]: object({ subscriptionId: str, serverTime: str, message: str }),
};

/** The schema served for one event type: the whole CloudEvent with `type` fixed and `data` closed */
export function eventSchema(type: EventType): JsonSchema {
  const envelope = envelopeSchema();
  return {
    $schema: DRAFT,
    $id: `urn:vexplor-aas:schema:${type}`,
    title: type,
    ...envelope,
    properties: { ...envelope.properties, type: { const: type }, data: DATA[type] },
    $defs: DEFS,
  };
}

/** The CloudEvents envelope (§2.1) with `data` left open */
export function envelopeSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      specversion: { const: '1.0' },
      id: str,
      source: str,
      type: str,
      time: str,
      subject: str,
      datacontenttype: { const: 'application/json' },
      dataschema: str,
      sequence: { type: 'string' },
      vxpackageid: str,
      vxrevision: int,
      vxcause: { type: 'string', enum: [...EVENT_CAUSES] },
      vxchangeset: str,
      data: { type: 'object' },
    },
    required: ['specversion', 'id', 'source', 'type', 'time', 'datacontenttype', 'sequence', 'data'],
    additionalProperties: false,
  };
}

export function schemaTypes(): readonly EventType[] {
  return ALL_EVENT_TYPES;
}
