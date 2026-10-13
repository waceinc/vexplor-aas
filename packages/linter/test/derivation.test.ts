/**
 * 형식 → 호기 반영 — 3자 비교(base · 지금 형식 · 지금 호기). src/derivation.ts
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

describe('형식 → 호기 반영', () => {
  it('형식만 바뀐 값은 반영 — 호기가 그때 형식 그대로일 때', () => {
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

  it('현장에서 고친 값은 건너뛴다 — 형식이 바뀌어도 덮지 않는다', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    (instance.submodels![0]!.submodelElements![1] as Json)['value'] = '95'; // 현장 수정
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ kind: 'changed', action: 'skip', reason: 'edited-here', mine: '95' })]);
    expect(valueAt(applyDerivation(instance, theirs, plan), 'TechnicalData', 'MaxSpeed')).toBe('95');
  });

  it('호기가 이미 새 형식 값과 같으면 보이지 않는다', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![1] as Json)['value'] = '120';
    const instance = clone(theirs);
    expect(planDerivation(base, theirs, instance)).toEqual([]);
  });

  it('형식에 새로 생긴 항목은 넣는다 — 묶음째 생기면 묶음 한 줄로(자식은 따라온다)', () => {
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

  it('넣을 자리(부모)가 호기에 없으면 건너뛴다', () => {
    const base = snapshotOf(TYPE);
    const instance = clone(TYPE);
    (instance.submodels![0]!.submodelElements as unknown as Json[]).splice(2, 1); // 호기에서 Motor 를 뺐다
    const theirs = clone(TYPE);
    ((theirs.submodels![0]!.submodelElements![2] as Json)['value'] as Json[]).push(prop('Rpm', '1800'));
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ path: 'Motor.Rpm', kind: 'added', action: 'skip', reason: 'parent-missing' })]);
  });

  it('형식에서 사라진 항목은 뺀다 — 단 호기에서 그 아래를 고쳤으면 빼지 않는다', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements as unknown as Json[]).splice(2, 1); // 형식에서 Motor 를 뺐다
    const untouched = clone(TYPE);
    const plan = planDerivation(base, theirs, untouched);
    expect(plan).toEqual([expect.objectContaining({ path: 'Motor', kind: 'removed', action: 'apply' })]);
    const after = applyDerivation(untouched, theirs, plan);
    expect((after.submodels![0]!.submodelElements as unknown as Json[]).map((e) => e['idShort'])).toEqual(['Manufacturer', 'MaxSpeed']);

    const edited = clone(TYPE);
    (((edited.submodels![0]!.submodelElements![2] as Json)['value'] as Json[])[0] as Json)['value'] = '7kW';
    expect(planDerivation(base, theirs, edited)).toEqual([expect.objectContaining({ path: 'Motor', kind: 'removed', action: 'skip', reason: 'edited-here' })]);
  });

  it('호기에 그 서브모델이 없으면 건너뛰고, 호기에만 있는 서브모델(수집 연결 등)은 보지 않는다', () => {
    const base = snapshotOf(TYPE);
    const theirs = clone(TYPE);
    (theirs.submodels![0]!.submodelElements![0] as Json)['value'] = 'WACE Co.';
    const instance = env([{ idShort: 'AssetInterfacesDescription', elements: [prop('X', '1')] }]);
    const plan = planDerivation(base, theirs, instance);
    expect(plan).toEqual([expect.objectContaining({ submodel: 'TechnicalData', action: 'skip', reason: 'submodel-missing' })]);
    expect(plan.some((c) => c.submodel === 'AssetInterfacesDescription')).toBe(false);
  });

  it('고르지 않은 「반영」 줄은 다음에도 다시 보인다 — 반영한 줄은 다시 안 보인다', () => {
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

  it('실제 파일 — 호기별로 복제한 직후에는 반영할 것이 없고, 형식 값 하나를 고치면 그 하나만 반영 대상이다', () => {
    const type = readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'))).environment;
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
