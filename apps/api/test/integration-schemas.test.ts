/**
 * Every event validates against its published JSON Schema (design §2.5; MES D).
 *
 * Covers the WP3 sample of every type, the envelope rendered by toCloudEvent, and — after the merge — the events the
 * WP2 / WP4 scenarios produce (`SCENARIO_BUILDERS`). The validator itself is checked to fail on what it must catch;
 * a validator that accepts everything would make this whole file green for nothing.
 */
import { ALL_EVENT_TYPES, EVENT_TYPES, isEventType, type EventType } from '@aas/core';
import { describe, expect, it } from 'vitest';

import { toCloudEvent } from '../src/integration/cloudevents.js';
import { checkSchema, type JsonSchema } from '../src/integration/schema-check.js';
import { envelopeSchema, eventSchema } from '../src/integration/schemas.js';
import { EXPORT_SCHEMAS } from '../src/integration/exports/export-schemas.js';
import { sampleRow, SCENARIO_BUILDERS } from './helpers/integration-scenarios.js';

const ctx = { instanceId: '9f2c4e1a7b3d', publicBaseUrl: 'https://aas.plant.local' };

describe('every type validates', () => {
  it.each([...ALL_EVENT_TYPES])('%s', (type) => {
    const event = toCloudEvent(sampleRow(type, 42), ctx);
    expect(checkSchema(eventSchema(type), event)).toEqual([]);
    expect(checkSchema(envelopeSchema(), event)).toEqual([]);
  });

  it.each(SCENARIO_BUILDERS)('events of the $name scenario', async ({ build }) => {
    const rows = await build();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(isEventType(row.type), row.type).toBe(true);
      expect(checkSchema(eventSchema(row.type as EventType), toCloudEvent(row, ctx)), row.type).toEqual([]);
    }
  });

  it('the scenarios cover every runtime and projection type', async () => {
    const seen = new Set<string>();
    for (const { build } of SCENARIO_BUILDERS) for (const row of await build()) seen.add(row.type);
    const expected = ALL_EVENT_TYPES.filter((type) => /\.equipment\.|\.collection\./.test(type));
    expect(expected.filter((type) => !seen.has(type))).toEqual([]);
  });
});

describe('export schemas (ERP E-3) are inside the checker subset', () => {
  it.each(Object.keys(EXPORT_SCHEMAS))('%s', (name) => {
    // An empty object must fail (required fields) — and the schema itself must use only supported keywords
    const errors = checkSchema(EXPORT_SCHEMAS[name] as JsonSchema, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.filter((error) => error.message.startsWith('schema uses'))).toEqual([]);
  });
});

describe('schemas catch drift', () => {
  const state = () => toCloudEvent(sampleRow(EVENT_TYPES.equipmentStateChanged), ctx);

  it('an extra data field is an error (closed schemas — leaks and silent contract changes)', () => {
    const event = state();
    (event.data as Record<string, unknown>)['submodelContent'] = { big: true };
    expect(checkSchema(eventSchema(EVENT_TYPES.equipmentStateChanged), event)[0]?.message).toMatch(/unexpected property "submodelContent"/);
  });

  it('a missing required field, a wrong enum, a wrong type, a wrong nested block', () => {
    const schema = eventSchema(EVENT_TYPES.equipmentStateChanged);
    const missing = state();
    delete (missing.data as Record<string, unknown>)['ruleSetHash'];
    expect(checkSchema(schema, missing).map((error) => error.message)).toContain('missing required "ruleSetHash"');
    const badEnum = state();
    (badEnum.data as Record<string, unknown>)['state'] = 'running';
    expect(checkSchema(schema, badEnum)).not.toEqual([]);
    const badType = state();
    (badType.data as Record<string, unknown>)['detectionResolutionMs'] = '30000';
    expect(checkSchema(schema, badType)[0]?.path).toBe('/data/detectionResolutionMs');
    const badAsset = state();
    ((badAsset.data as Record<string, unknown>)['asset'] as Record<string, unknown>)['externalRefs'] = [{ system: 's', type: 'costCenter', id: '1', sensitive: true }];
    expect(checkSchema(schema, badAsset)).not.toEqual([]);
  });

  it('the envelope pins type, specversion and the vxcause values', () => {
    const event = state();
    expect(checkSchema(eventSchema(EVENT_TYPES.equipmentAlarmRaised), event)).not.toEqual([]);
    expect(checkSchema(envelopeSchema(), { ...event, specversion: '0.3' })).not.toEqual([]);
    expect(checkSchema(envelopeSchema(), { ...event, vxcause: 'whatever' })).not.toEqual([]);
    expect(checkSchema(envelopeSchema(), { ...event, extra: 1 })).not.toEqual([]);
  });
});

describe('validator subset', () => {
  it('refuses unsupported keywords instead of ignoring them', () => {
    expect(checkSchema({ type: 'string', pattern: '^a' } as JsonSchema, 'b')[0]?.message).toMatch(/unsupported keyword "pattern"/);
  });

  it('nullable via type list, integer vs number, anyOf, $ref, minimum, const', () => {
    expect(checkSchema({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(checkSchema({ type: 'integer' }, 1.5)).not.toEqual([]);
    expect(checkSchema({ type: 'number' }, 2)).toEqual([]);
    expect(checkSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 3)).not.toEqual([]);
    const root: JsonSchema = { $defs: { n: { type: 'integer', minimum: 1 } }, $ref: '#/$defs/n' };
    expect(checkSchema(root, 0)).not.toEqual([]);
    expect(checkSchema(root, 2)).toEqual([]);
    expect(checkSchema({ $ref: '#/$defs/missing' }, 1)).not.toEqual([]);
    expect(checkSchema({ const: true }, false)).not.toEqual([]);
  });
});
