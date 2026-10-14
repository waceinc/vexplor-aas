/**
 * Type → unit propagation — three-way comparison (base · current type · current unit). src/derivation.ts
 */
import type { Environment } from '@aas/core';
import { readAasx } from '@aas/aasx';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyDerivation, nextSnapshot, planDerivation, renameEnvironment, snapshotOf } from '@aas/linter';

type Json = Record<string, unknown>;
const prop = (idShort: string, value: string): Json => ({ modelType: 'Property', idShort, valueType: 'xs:string', value });
const coll = (idShort: string, value: Json[]): Json => ({ modelType: 'SubmodelElementCollection', idShort, value });
const env = (submodels: { idShort: string; elements: Json[] }[]): Environment =>
  ({
    submodels: submodels.map((sm) => ({ modelType: 'Submodel', id: `urn:${sm.idShort}`, idShort: sm.idShort, submodelElements: sm.elements })),
  }) as unknown as Environment;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const valueAt = (environment: Environment, submodel: string, idShort: string): unknown => {
  const sm = (environment.submodels as unknown as Json[]).find((s) => s['idShort'] === submodel)!;
  const find = (items: Json[]): Json | undefined => {
    for (const item of items) {
      if (item['idShort'] === idShort) return item;
      const inner = Array.isArray(item['value']) ? find(item['value'] as Json[]) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return find(sm['submodelElements'] as Json[])?.['value'];
};

const TYPE = env([
  {
    idShort: 'TechnicalData',
    elements: [prop('Manufacturer', 'WACE'), prop('MaxSpeed', '100'), coll('Motor', [prop('Power', '5kW'), prop('Voltage', '380V')])],
  },
]);

describe('type → unit propagation', () => {
  it('propagates values changed only in the type — when the unit still matches the type as of then', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([
      expect.objectContaining({ key: 'TechnicalData/MaxSpeed', kind: 'changed', action: 'apply', base: '100', theirs: '120', mine: '100' }),
    ]);
    expect(valueAt(applyDerivation(instance, theirs, plan), 'TechnicalData', 'MaxSpeed')).toBe('120');
  });

  it('skips values edited in the field — does not overwrite them even if the type changed', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    (instance.submodels![0]!.submodelElements![1] as Json)['value'] = '95'; // field edit
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ kind: 'changed', action: 'skip', reason: 'edited-here', mine: '95' })]);
    expect(valueAt(applyDerivation(instance, theirs, plan), 'TechnicalData', 'MaxSpeed')).toBe('95');
  });

  it('does not show values where the unit already equals the new type value', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const instance = clone(theirs);
    expect(planDerivation(base, theirs, instance)).toEqual([]);
  });

  it('adds items newly created in the type — a whole new collection is one line (children come along)', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    const theirs = clone(TYPE);
    const elements = theirs.submodels![0]!.submodelElements as unknown as Json[];
    elements.splice(2, 0, prop('Weight', '1200kg'));
    elements.push(coll('Cooling', [prop('Type', 'Air')]));
    const plan = planDerivation(base, theirs, instance);
    expect(plan.map((c) => [c.path, c.kind, c.action])).toEqual([
      ['Cooling', 'added', 'apply'],
      ['Weight', 'added', 'apply'],
    ]);
    const after = applyDerivation(instance, theirs, plan);
    const names = (after.submodels![0]!.submodelElements as unknown as Json[]).map((e) => e['idShort']);
    expect(names).toEqual(['Manufacturer', 'MaxSpeed', 'Weight', 'Motor', 'Cooling']);
    expect(valueAt(after, 'TechnicalData', 'Type')).toBe('Air');
  });

  it('skips when the insertion point (parent) does not exist in the unit', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    (instance.submodels![0]!.submodelElements as unknown as Json[]).splice(2, 1); // removed Motor from the unit
    const theirs = clone(TYPE);
    ((theirs.submodels![0]!.submodelElements![2] as Json)['value'] as Json[]).push(prop('Rpm', '1800'));
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ path: 'Motor.Rpm', kind: 'added', action: 'skip', reason: 'parent-missing' })]);
  });

  it('removes items that disappeared from the type — unless something beneath them was edited in the unit', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements as unknown as Json[]).splice(2, 1); // removed Motor from the type
    const untouched = clone(TYPE);
    const plan = planDerivation(base, theirs, untouched);
    expect(plan).toEqual([expect.objectContaining({ path: 'Motor', kind: 'removed', action: 'apply' })]);
    const after = applyDerivation(untouched, theirs, plan);
    expect((after.submodels![0]!.submodelElements as unknown as Json[]).map((e) => e['idShort'])).toEqual(['Manufacturer', 'MaxSpeed']);

    const edited = clone(TYPE);
    (((edited.submodels![0]!.submodelElements![2] as Json)['value'] as Json[])[0] as Json)['value'] = '7kW';
    expect(planDerivation(base, theirs, edited)).toEqual([expect.objectContaining({ path: 'Motor', kind: 'removed', action: 'skip', reason: 'edited-here' })]);
  });

  it('skips when the unit lacks that submodel, and ignores unit-only submodels (data-collection bindings, etc.)', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![0] as Json)['value'] = 'WACE Co.';
    const instance = env([{ idShort: 'AssetInterfacesDescription', elements: [prop('X', '1')] }]);
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ submodel: 'TechnicalData', action: 'skip', reason: 'submodel-missing' })]);
    expect(plan.some((c) => c.submodel === 'AssetInterfacesDescription')).toBe(false);
  });

  it('unselected "apply" lines show up again next time — applied lines do not', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![0] as Json)['value'] = 'WACE Co.';
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const plan = planDerivation(base, theirs, instance);
    const picked = plan.filter((c) => c.path === 'MaxSpeed');
    const after = applyDerivation(instance, theirs, picked);
    const again = planDerivation(nextSnapshot(base, theirs, plan, new Set(picked.map((c) => c.key))), theirs, after);
    expect(again.map((c) => [c.path, c.action])).toEqual([['Manufacturer', 'apply']]);
  });

  it('real file — right after per-unit cloning nothing needs propagating; editing one type value makes only that one a candidate', () => {
    const type = readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))).environment;
    const base = snapshotOf(type);
    const instance = renameEnvironment(clone(type), 'RollFormingMachine_1', 'https://www.smart-factory.kr/ids');
    expect(planDerivation(base, type, instance).filter((c) => c.action === 'apply')).toEqual([]);

    const theirs = clone(type);
    const nameplate = (theirs.submodels as unknown as Json[]).find((sm) => sm['idShort'] === 'DigitalNameplate')!;
    const year = (nameplate['submodelElements'] as Json[]).find((e) => e['idShort'] === 'YearOfConstruction')!;
    year['value'] = '2027';
    const plan = planDerivation(base, theirs, instance).filter((c) => c.action === 'apply');
    expect(plan.map((c) => c.key)).toEqual(['DigitalNameplate/YearOfConstruction']);
    expect(valueAt(applyDerivation(instance, theirs, plan), 'DigitalNameplate', 'YearOfConstruction')).toBe('2027');
  });
});
