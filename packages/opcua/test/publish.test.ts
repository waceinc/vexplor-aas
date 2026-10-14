/**
 * Publish engine (M7) checks — is the AAS hierarchy carried over into an OPC UA node tree?
 *
 * Most important here: **the NodeId must equal the Part 2 idShortPath**.
 * If REST and OPC UA call the same element by different names, they cannot be cross-checked on site.
 * Next: "are nodes kept even in a defective file?" — losing them repeats basyx's mistake.
 */
import { describe, expect, it } from 'vitest';
import type { Environment } from '@aas/core';
import { flattenVariables, opcTypeOf, planForPackage } from '../src/publish.js';

const PID = 'pkg-1';

function env(elements: unknown[], extra?: Partial<Environment>): Environment {
  return {
    assetAdministrationShells: [
      { modelType: 'AssetAdministrationShell', id: 'aas-1', idShort: '롤포밍기', assetInformation: { assetKind: 'Type' } },
    ],
    submodels: [
      {
        modelType: 'Submodel',
        id: 'https://ktl/sm/tech',
        idShort: 'TechnicalData',
        submodelElements: elements,
      },
    ],
    ...extra,
  } as unknown as Environment;
}

const prop = (idShort: string, valueType: string, value?: string): unknown => ({
  modelType: 'Property',
  idShort,
  valueType,
  ...(value === undefined ? {} : { value }),
});

describe('opcTypeOf', () => {
  it('narrows xs types down to five kinds', () => {
    expect(opcTypeOf('xs:boolean')).toBe('Boolean');
    expect(opcTypeOf('xs:double')).toBe('Double');
    expect(opcTypeOf('xs:float')).toBe('Double');
    expect(opcTypeOf('xs:int')).toBe('Int32');
    expect(opcTypeOf('xs:long')).toBe('Int64');
    expect(opcTypeOf('xs:string')).toBe('String');
  });

  it('Important: falls back to String for unknown types — guessing a number makes values vanish silently', () => {
    expect(opcTypeOf('xs:dateTime')).toBe('String');
    expect(opcTypeOf(undefined)).toBe('String');
    expect(opcTypeOf('xs:존재하지않음')).toBe('String');
  });
});

describe('planForPackage', () => {
  it('a submodel becomes a folder and a Property a variable', () => {
    const plan = planForPackage(env([prop('MotorSpeed', 'xs:double', '1200.5')]), { packageId: PID });
    expect(plan.name).toBe('롤포밍기');
    expect(plan.variables).toBe(1);
    const submodel = plan.children[0];
    expect(submodel).toMatchObject({ name: 'TechnicalData', kind: 'folder' });
    expect(submodel?.children[0]).toMatchObject({
      name: 'MotorSpeed',
      kind: 'variable',
      dataType: 'Double',
      value: '1200.5',
    });
  });

  it('Important: NodeId equals the Part 2 path — <package>/<submodel id>/<idShortPath>', () => {
    const plan = planForPackage(env([prop('MotorSpeed', 'xs:double')]), { packageId: PID });
    expect(plan.children[0]?.children[0]?.nodeId).toBe('pkg-1/https://ktl/sm/tech/MotorSpeed');
  });

  it('joins SMC children with dots', () => {
    const plan = planForPackage(
      env([
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'Motor',
          value: [prop('Speed', 'xs:int', '30')],
        },
      ]),
      { packageId: PID },
    );
    const collection = plan.children[0]?.children[0];
    expect(collection?.kind).toBe('folder');
    expect(collection?.children[0]?.nodeId).toBe('pkg-1/https://ktl/sm/tech/Motor.Speed');
  });

  it('Important: SML children survive without an idShort (AASd-120) — [n] without a dot', () => {
    const plan = planForPackage(
      env([
        {
          modelType: 'SubmodelElementList',
          idShort: 'Points',
          value: [
            { modelType: 'Property', valueType: 'xs:double', value: '1' },
            { modelType: 'Property', valueType: 'xs:double', value: '2' },
          ],
        },
      ]),
      { packageId: PID },
    );
    const list = plan.children[0]?.children[0];
    expect(list?.children).toHaveLength(2);
    expect(list?.children[0]?.nodeId).toBe('pkg-1/https://ktl/sm/tech/Points[0]');
    expect(list?.children[1]?.nodeId).toBe('pkg-1/https://ktl/sm/tech/Points[1]');
    expect(list?.children[0]?.name).toBe('[0]');
    expect(plan.variables).toBe(2);
  });

  it('Important: keeps nodes even when idShorts collide — does not swallow them silently like basyx', () => {
    const plan = planForPackage(
      env([prop('Speed', 'xs:int', '1'), prop('Speed', 'xs:int', '2')]),
      { packageId: PID },
    );
    const names = plan.children[0]?.children.map((n) => n.name);
    const ids = plan.children[0]?.children.map((n) => n.nodeId);
    expect(names).toEqual(['Speed', 'Speed_2']);
    expect(new Set(ids).size).toBe(2);
    expect(plan.variables).toBe(2);
  });

  it('MultiLanguageProperty outputs the first language as a string', () => {
    const plan = planForPackage(
      env([
        {
          modelType: 'MultiLanguageProperty',
          idShort: 'Note',
          value: [{ language: 'ko', text: '정상' }, { language: 'en', text: 'ok' }],
        },
      ]),
      { packageId: PID },
    );
    expect(plan.children[0]?.children[0]).toMatchObject({ dataType: 'String', value: '정상' });
  });

  it('Range outputs the interval in human-readable form', () => {
    const plan = planForPackage(
      env([{ modelType: 'Range', idShort: 'Temp', valueType: 'xs:double', min: '0', max: '80' }]),
      { packageId: PID },
    );
    expect(plan.children[0]?.children[0]).toMatchObject({ dataType: 'String', value: '0..80' });
  });

  it('a submodel without idShort does not disappear from the tree', () => {
    const environment = {
      submodels: [{ modelType: 'Submodel', id: 'https://ktl/sm/x', submodelElements: [] }],
    } as unknown as Environment;
    const plan = planForPackage(environment, { packageId: PID, name: '이름없음' });
    expect(plan.children[0]?.name).toBe('https://ktl/sm/x');
    expect(plan.name).toBe('이름없음');
  });

  it('flattenVariables finds all variables regardless of depth', () => {
    const plan = planForPackage(
      env([
        prop('A', 'xs:int', '1'),
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'C',
          value: [prop('B', 'xs:int', '2'), { modelType: 'SubmodelElementCollection', idShort: 'D', value: [prop('E', 'xs:int', '3')] }],
        },
      ]),
      { packageId: PID },
    );
    expect(flattenVariables(plan).map((n) => n.name)).toEqual(['A', 'B', 'E']);
    expect(plan.variables).toBe(3);
  });
});
