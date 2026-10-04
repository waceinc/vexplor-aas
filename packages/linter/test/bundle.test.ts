/**
 * 번들 연계 분석 — semanticId로 묶되, semanticId만 믿으면 틀리는 두 경우를 알린다.
 * 두 경우 모두 사업 참조모델 30종에서 실측된 모양이다(2026-09-30).
 */
import type { Environment, Property, Submodel } from '@aas/core';
import { bundleLinkage, linkageCsv, linkPointsOf } from '@aas/linter';
import { describe, expect, it } from 'vitest';

const prop = (idShort: string, semanticId: string): Property => ({
  modelType: 'Property',
  idShort,
  valueType: 'xs:string',
  semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: semanticId }] },
});

const env = (name: string, props: Property[]): Environment => ({
  assetAdministrationShells: [],
  submodels: [
    {
      modelType: 'Submodel',
      id: `urn:${name}:op`,
      idShort: 'OperationalData',
      submodelElements: [{ modelType: 'SubmodelElementCollection', idShort: 'Status', value: props }],
    } as Submodel,
    { modelType: 'Submodel', id: `urn:${name}:tech`, idShort: 'TechnicalData', submodelElements: [prop('Ignored', 'urn:x')] } as Submodel,
  ],
  conceptDescriptions: [],
});

const KOSMO_STATE = 'https://www.smart-factory.kr/ids/cd/MachineState/1/0';
const ECLASS_STATUS = '0173-1#02-ABC132#004';

describe('bundleLinkage', () => {
  it('운전 데이터만 훑고 경로를 서브모델부터 적는다', () => {
    const points = linkPointsOf('A', env('a', [prop('MachineState', KOSMO_STATE)]));
    expect(points).toEqual([
      expect.objectContaining({ path: 'OperationalData/Status/MachineState', semanticId: KOSMO_STATE }),
    ]);
  });

  it('semanticId로 묶고 보유 설비 수를 센다 · 파일 없는 설비는 빠진다', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'B', globalAssetId: 'b', environment: env('b', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'C', globalAssetId: 'c' },
    ]);
    expect(linkage.members).toEqual(['A', 'B']);
    expect(linkage.missing).toEqual(['C']);
    expect(linkage.items[0]).toMatchObject({ semanticId: KOSMO_STATE, coverage: 2, label: 'MachineState' });
  });

  it('🔴 같은 semanticId를 다른 이름이 쓰면 경고한다 (ABC132 재사용)', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', ECLASS_STATUS), prop('AlarmCode', ECLASS_STATUS)]) },
    ]);
    const shared = linkage.findings.filter((f) => f.kind === 'shared-semantic');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.severity).toBe('warning');
    expect(shared[0]!.names.sort()).toEqual(['AlarmCode', 'MachineState']);
  });

  it('같은 이름이 semanticId 둘로 갈리면 알린다 (KOSMO IRI · ECLASS IRDI)', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'B', globalAssetId: 'b', environment: env('b', [prop('MachineState', ECLASS_STATUS)]) },
    ]);
    const split = linkage.findings.filter((f) => f.kind === 'split-semantic');
    expect(split).toHaveLength(1);
    expect(split[0]!.semanticIds.sort()).toEqual([ECLASS_STATUS, KOSMO_STATE].sort());
  });

  it('같은 설비가 두 번 나와도 한 번만 센다', () => {
    const e = env('a', [prop('MachineState', KOSMO_STATE)]);
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: e },
      { name: 'A', globalAssetId: 'a', environment: e },
    ]);
    expect(linkage.members).toEqual(['A']);
    expect(linkage.items[0]!.coverage).toBe(1);
  });

  it('CSV — 사람이 채울 칸을 비워 두고 BOM을 붙인다', () => {
    const csv = linkageCsv(
      bundleLinkage([{ name: 'A', globalAssetId: 'a', environment: env('a', [prop('Machine,State', KOSMO_STATE)]) }]),
    );
    expect(csv.startsWith('﻿연계 키(사람이 채움)')).toBe(true);
    expect(csv).toContain(',,"Machine,State",');
  });
});
