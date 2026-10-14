/**
 * 템플릿 요구 수준 — IDTA 템플릿의 개수 조건에서 「필수 · 선택」을 읽는다(src/requirements.ts).
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
    // 옛 판 한정자 이름
    { modelType: 'Property', idShort: 'YearOfConstruction', ...q('One', 'Multiplicity') },
    // 개수 조건이 없는 요소 — 모른다
    { modelType: 'Property', idShort: 'Unknown' },
  ],
};

describe('템플릿 요구 수준', () => {
  it('개수 조건을 읽는다 — SMT/Cardinality · 옛 판 Multiplicity, 없으면 모른다', () => {
    expect(cardinalityOf(q('One'))).toBe('One');
    expect(cardinalityOf(q('zerotomany'))).toBe('ZeroToMany');
    expect(cardinalityOf(q('One', 'Multiplicity'))).toBe('One');
    expect(cardinalityOf({})).toBeUndefined();
    expect(cardinalityOf(q('Several'))).toBeUndefined();
  });

  it('경로마다 필수·선택 — 🔴 선택 묶음 안의 One 은 필수가 아니다', () => {
    const r = templateRequirements(NAMEPLATE);
    expect(r['ManufacturerName']).toEqual({ cardinality: 'One', required: true });
    expect(r['SerialNumber']).toEqual({ cardinality: 'ZeroToOne', required: false });
    expect(r['ContactInformation.Street']).toEqual({ cardinality: 'One', required: false });
    expect(r['AddressInformation.CityTown']).toEqual({ cardinality: 'One', required: true });
    expect(r['YearOfConstruction']!.required).toBe(true);
    expect(r['Unknown']).toBeUndefined();
    // 리스트 자식은 자리 번호 없이 `[]`
    expect(r['Markings[]']).toEqual({ cardinality: 'OneToMany', required: false });
    expect(r['Markings[].MarkingName']!.required).toBe(false);
  });

  it('인스턴스 경로의 자리 번호를 지워 템플릿과 맞춘다', () => {
    expect(normalizeElementPath('Markings[3].MarkingName')).toBe('Markings[].MarkingName');
    expect(normalizeElementPath('A.B')).toBe('A.B');
  });

  it('카탈로그 — Template 서브모델만, semanticId 로 묶는다. 인스턴스(kind 없음)는 넣지 않는다', () => {
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
