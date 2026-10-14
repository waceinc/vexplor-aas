/**
 * The value table "category" decision: required / collected / optional / unknown (components/inspector/need.ts).
 */
import { describe, expect, it } from 'vitest';
import type { SubmodelRequirement } from '../src/api.js';
import { needOf } from '../src/components/inspector/need.js';

const requirement: SubmodelRequirement = {
  submodelId: 'urn:sm',
  semanticId: 'urn:sem',
  elements: {
    ManufacturerName: { cardinality: 'One', required: true },
    SerialNumber: { cardinality: 'ZeroToOne', required: false },
    'Markings[].MarkingName': { cardinality: 'One', required: true },
  },
};

describe('value table category', () => {
  it('uses the template required/optional as is; list children are matched with their index removed', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', requirement, undefined)).toBe('required');
    expect(needOf('SerialNumber', 'SerialNumber', requirement, undefined)).toBe('optional');
    expect(needOf('Markings[2].MarkingName', 'MarkingName', requirement, undefined)).toBe('required');
  });

  it('Important: a matching name in a collection connection makes it collected first (even if required, it is not a cell for people to fill)', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', requirement, new Set(['ManufacturerName']))).toBe('collected');
    // even without a template, the collection connection knows
    expect(needOf('MotorSpeed', 'MotorSpeed', undefined, new Set(['MotorSpeed']))).toBe('collected');
  });

  it('does not make things up: no template or not in the template means unknown', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', undefined, undefined)).toBe('unknown');
    expect(needOf('CustomField', 'CustomField', requirement, new Set())).toBe('unknown');
  });
});
