/**
 * JSON Schemas of the JSON exports (design §4.4, ERP E-3) — the same draft 2020-12 subset as the event schemas
 * (`type` incl. type arrays for nullable, `properties`, `required`, `enum`, `items`, `additionalProperties`), so WP3's
 * in-repo checker validates them too. Integrators may vendor these to validate what they receive.
 */
type Schema = Record<string, unknown>;

const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const texts = { type: 'array', items: text };
const pair = { type: 'object', required: ['name', 'value'], properties: { name: text, value: text }, additionalProperties: false };
const source = {
  type: 'object',
  required: ['tool', 'version', 'instanceId'],
  properties: { tool: text, version: text, instanceId: nullableText },
  additionalProperties: false,
};
const envelope = (schema: string, item: Schema, extra: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schema,
  type: 'object',
  required: ['schema', 'exportedAt', 'source', 'items', ...required],
  properties: { schema: { enum: [schema] }, exportedAt: text, source, items: { type: 'array', items: item }, ...extra },
  additionalProperties: false,
});

const equipmentItem: Schema = {
  type: 'object',
  required: ['key', 'aasId', 'assetKind', 'typeAasId', 'packageId', 'revision', 'nameplate', 'physical', 'location', 'specificAssetIds', 'externalRefs', 'missing', 'warnings'],
  properties: {
    key: text,
    aasId: text,
    assetKind: nullableText,
    typeAasId: nullableText,
    packageId: text,
    revision: { type: 'integer' },
    nameplate: {
      type: 'object',
      required: ['manufacturer', 'productDesignation', 'productFamily', 'modelNumber', 'orderCode', 'serialNumber', 'yearOfConstruction', 'dateOfManufacture', 'productUri', 'markings'],
      properties: {
        manufacturer: nullableText,
        productDesignation: nullableText,
        productFamily: nullableText,
        modelNumber: nullableText,
        orderCode: nullableText,
        serialNumber: nullableText,
        yearOfConstruction: nullableText,
        dateOfManufacture: nullableText,
        productUri: nullableText,
        markings: texts,
      },
      additionalProperties: false,
    },
    physical: {
      type: 'object',
      required: ['weight'],
      properties: {
        weight: {
          type: ['object', 'null'],
          required: ['value', 'unit'],
          properties: { value: { type: ['number', 'null'] }, unit: nullableText },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    location: {
      type: 'object',
      required: ['path', 'isa95'],
      properties: {
        path: texts,
        isa95: {
          type: 'object',
          required: ['site', 'area', 'workCenter'],
          properties: { site: nullableText, area: nullableText, workCenter: nullableText },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    specificAssetIds: { type: 'array', items: pair },
    externalRefs: {
      type: 'array',
      items: { type: 'object', required: ['system', 'type', 'id'], properties: { system: text, type: text, id: text }, additionalProperties: false },
    },
    sourcePaths: { type: 'object' },
    missing: texts,
    warnings: texts,
  },
  additionalProperties: false,
};

const excluded = {
  type: 'array',
  items: { type: 'object', required: ['packageId', 'aasId', 'reason'], properties: { packageId: text, aasId: nullableText, reason: text }, additionalProperties: false },
};

const bomItem: Schema = {
  type: 'object',
  required: ['rootKey', 'parentPath', 'childPath', 'childName', 'childGlobalAssetId', 'quantity', 'level', 'entityType', 'erpMaterial', 'mapped'],
  properties: {
    rootKey: text,
    parentPath: text,
    childPath: text,
    childName: text,
    childGlobalAssetId: nullableText,
    quantity: { type: 'number' },
    level: { type: 'integer' },
    entityType: nullableText,
    erpMaterial: {
      type: 'array',
      items: { type: 'object', required: ['system', 'id'], properties: { system: text, id: text }, additionalProperties: false },
    },
    mapped: { type: 'boolean' },
  },
  additionalProperties: false,
};

const hierarchyItem: Schema = {
  type: 'object',
  required: ['id', 'parentId', 'equipmentLevel', 'name', 'globalAssetId', 'aasId', 'packageId', 'serialNumber', 'quantity', 'specificAssetIds', 'warnings'],
  properties: {
    id: text,
    parentId: nullableText,
    equipmentLevel: { enum: ['Enterprise', 'Site', 'Area', 'WorkCenter', 'WorkUnit'] },
    name: text,
    globalAssetId: nullableText,
    aasId: nullableText,
    packageId: nullableText,
    serialNumber: nullableText,
    quantity: { type: 'number' },
    specificAssetIds: { type: 'array', items: pair },
    warnings: texts,
  },
  additionalProperties: false,
};

export const EXPORT_SCHEMAS: Record<string, Schema> = {
  'vexplor.equipmentMaster/1': envelope('vexplor.equipmentMaster/1', equipmentItem, { language: text, excluded }, ['language', 'excluded']),
  'vexplor.bom/1': envelope(
    'vexplor.bom/1',
    bomItem,
    { packageId: text, revision: { type: 'integer' }, rootKey: text },
    ['packageId', 'revision', 'rootKey'],
  ),
  'kr.vexplor.aas.hierarchy.v1': envelope(
    'kr.vexplor.aas.hierarchy.v1',
    hierarchyItem,
    { packageId: text, revision: { type: 'integer' }, site: nullableText, warnings: texts },
    ['packageId', 'revision', 'site', 'warnings'],
  ),
};
