/**
 * Bundle linkage analysis — groups by semanticId, but flags the two cases where trusting
 * semanticId alone goes wrong. Both shapes were observed in the project's 30 reference models (2026-09-30).
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
  it('scans only operational data and writes paths starting from the submodel', () => {
    const points = linkPointsOf('A', env('a', [prop('MachineState', KOSMO_STATE)]));
    expect(points).toEqual([
      expect.objectContaining({ path: 'OperationalData/Status/MachineState', semanticId: KOSMO_STATE }),
    ]);
  });

  it('groups by semanticId and counts the equipment that has it · equipment without a file is excluded', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'B', globalAssetId: 'b', environment: env('b', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'C', globalAssetId: 'c' },
    ]);
    expect(linkage.members).toEqual(['A', 'B']);
    expect(linkage.missing).toEqual(['C']);
    expect(linkage.items[0]).toMatchObject({ semanticId: KOSMO_STATE, coverage: 2, label: 'MachineState' });
  });

  it('Important: warns when different names use the same semanticId (ABC132 reuse)', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', ECLASS_STATUS), prop('AlarmCode', ECLASS_STATUS)]) },
    ]);
    const shared = linkage.findings.filter((f) => f.kind === 'shared-semantic');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.severity).toBe('warning');
    expect(shared[0]!.names.sort()).toEqual(['AlarmCode', 'MachineState']);
  });

  it('flags when one name splits across two semanticIds (KOSMO IRI · ECLASS IRDI)', () => {
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: env('a', [prop('MachineState', KOSMO_STATE)]) },
      { name: 'B', globalAssetId: 'b', environment: env('b', [prop('MachineState', ECLASS_STATUS)]) },
    ]);
    const split = linkage.findings.filter((f) => f.kind === 'split-semantic');
    expect(split).toHaveLength(1);
    expect(split[0]!.semanticIds.sort()).toEqual([ECLASS_STATUS, KOSMO_STATE].sort());
  });

  it('counts the same equipment only once even if it appears twice', () => {
    const e = env('a', [prop('MachineState', KOSMO_STATE)]);
    const linkage = bundleLinkage([
      { name: 'A', globalAssetId: 'a', environment: e },
      { name: 'A', globalAssetId: 'a', environment: e },
    ]);
    expect(linkage.members).toEqual(['A']);
    expect(linkage.items[0]!.coverage).toBe(1);
  });

  it('CSV — leaves the human-filled column blank and prepends a BOM', () => {
    const csv = linkageCsv(
      bundleLinkage([{ name: 'A', globalAssetId: 'a', environment: env('a', [prop('Machine,State', KOSMO_STATE)]) }]),
    );
    expect(csv.startsWith('﻿연계 키(사람이 채움)')).toBe(true);
    expect(csv).toContain(',,"Machine,State",');
  });
});
