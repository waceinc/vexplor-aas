/**
 * Template requirement levels — reads "required / optional" from IDTA template cardinality (src/requirements.ts).
 */
import type { Environment } from '@aas/core';
import { describe, expect, it } from 'vitest';
import { cardinalityOf, collectTemplateCatalog, normalizeElementPath, templateRequirements } from '@aas/linter';

const q = (value: string, type = 'SMT/Cardinality') => ({ qualifiers: [{ type, valueType: 'xs:string', value }] });

const NAMEPLATE = {
  modelType: 'Submodel',
  kind: 'Template',
  idShort: 'Nameplate',
  id: 'urn:tpl:nameplate',
  semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'https://admin-shell.io/idta/nameplate/3/0/Nameplate' }] },
  submodelElements: [
    { modelType: 'MultiLanguageProperty', idShort: 'ManufacturerName', ...q('One') },
    { modelType: 'Property', idShort: 'SerialNumber', ...q('ZeroToOne') },
    {
      modelType: 'SubmodelElementCollection',
      idShort: 'ContactInformation',
      ...q('ZeroToOne'),
      value: [{ modelType: 'Property', idShort: 'Street', ...q('One') }],
    },
    {
      modelType: 'SubmodelElementCollection',
      idShort: 'AddressInformation',
      ...q('One'),
      value: [{ modelType: 'Property', idShort: 'CityTown', ...q('One') }],
    },
    {
      modelType: 'SubmodelElementList',
      idShort: 'Markings',
      ...q('ZeroToOne'),
      value: [
        { modelType: 'SubmodelElementCollection', ...q('OneToMany'), value: [{ modelType: 'Property', idShort: 'MarkingName', ...q('One') }] },
      ],
    },
    // legacy qualifier name
    { modelType: 'Property', idShort: 'YearOfConstruction', ...q('One', 'Multiplicity') },
    // element without a cardinality — unknown
    { modelType: 'Property', idShort: 'Unknown' },
  ],
};

describe('Template requirement levels', () => {
  it('reads cardinality — SMT/Cardinality or legacy Multiplicity; unknown if absent', () => {
    expect(cardinalityOf(q('One'))).toBe('One');
    expect(cardinalityOf(q('zerotomany'))).toBe('ZeroToMany');
    expect(cardinalityOf(q('One', 'Multiplicity'))).toBe('One');
    expect(cardinalityOf({})).toBeUndefined();
    expect(cardinalityOf(q('Several'))).toBeUndefined();
  });

  it('required/optional per path — Important: One inside an optional collection is not required', () => {
    const r = templateRequirements(NAMEPLATE);
    expect(r['ManufacturerName']).toEqual({ cardinality: 'One', required: true });
    expect(r['SerialNumber']).toEqual({ cardinality: 'ZeroToOne', required: false });
    expect(r['ContactInformation.Street']).toEqual({ cardinality: 'One', required: false });
    expect(r['AddressInformation.CityTown']).toEqual({ cardinality: 'One', required: true });
    expect(r['YearOfConstruction']!.required).toBe(true);
    expect(r['Unknown']).toBeUndefined();
    // list children use `[]` without an index
    expect(r['Markings[]']).toEqual({ cardinality: 'OneToMany', required: false });
    expect(r['Markings[].MarkingName']!.required).toBe(false);
  });

  it('strips indices from instance paths to match the template', () => {
    expect(normalizeElementPath('Markings[3].MarkingName')).toBe('Markings[].MarkingName');
    expect(normalizeElementPath('A.B')).toBe('A.B');
  });

  it('catalog — Template submodels only, grouped by semanticId; instances (no kind) are excluded', () => {
    const instance = { ...NAMEPLATE, kind: 'Instance', id: 'urn:inst' };
    const catalog = collectTemplateCatalog([
      { submodels: [instance] } as unknown as Environment,
      { submodels: [NAMEPLATE] } as unknown as Environment,
    ]);
    const entry = catalog.get('https://admin-shell.io/idta/nameplate/3/0/Nameplate');
    expect(entry?.templateIdShort).toBe('Nameplate');
    expect(entry?.elements['ManufacturerName']?.required).toBe(true);
    expect(collectTemplateCatalog([{ submodels: [instance] } as unknown as Environment]).size).toBe(0);
  });
});
