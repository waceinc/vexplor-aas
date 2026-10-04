/**
 * 배포 엔진(M7) 검증 — AAS 계층이 OPC UA 노드 트리로 옮겨지는가.
 *
 * 여기서 가장 중요한 것은 **NodeId가 Part 2 idShortPath와 같아야 한다**는 점이다.
 * 같은 요소를 REST와 OPC UA가 다른 이름으로 부르면 현장에서 대조가 안 된다.
 * 그다음이 「결함 있는 파일에서도 노드를 잃지 않는가」다 — 잃으면 basyx와 같은 죄를 짓는다.
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
  it('xs 자료형을 다섯 갈래로 좁힌다', () => {
    expect(opcTypeOf('xs:boolean')).toBe('Boolean');
    expect(opcTypeOf('xs:double')).toBe('Double');
    expect(opcTypeOf('xs:float')).toBe('Double');
    expect(opcTypeOf('xs:int')).toBe('Int32');
    expect(opcTypeOf('xs:long')).toBe('Int64');
    expect(opcTypeOf('xs:string')).toBe('String');
  });

  it('🔴 모르는 것은 String으로 떨어뜨린다 — 숫자로 넘겨짚으면 값이 조용히 사라진다', () => {
    expect(opcTypeOf('xs:dateTime')).toBe('String');
    expect(opcTypeOf(undefined)).toBe('String');
    expect(opcTypeOf('xs:존재하지않음')).toBe('String');
  });
});

describe('planForPackage', () => {
  it('서브모델은 폴더, Property는 변수가 된다', () => {
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

  it('🔴 NodeId가 Part 2 경로와 같다 — <패키지>/<서브모델 id>/<idShortPath>', () => {
    const plan = planForPackage(env([prop('MotorSpeed', 'xs:double')]), { packageId: PID });
    expect(plan.children[0]?.children[0]?.nodeId).toBe('pkg-1/https://ktl/sm/tech/MotorSpeed');
  });

  it('SMC 안쪽은 점으로 잇는다', () => {
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

  it('🔴 SML 자식은 idShort가 없어도 살아남는다 (AASd-120) — 점 없이 [n]', () => {
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

  it('🔴 idShort가 겹쳐도 노드를 잃지 않는다 — basyx처럼 조용히 삼키지 않는다', () => {
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

  it('MultiLanguageProperty는 첫 언어를 문자열로 낸다', () => {
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

  it('Range는 구간을 사람이 읽게 붙여 낸다', () => {
    const plan = planForPackage(
      env([{ modelType: 'Range', idShort: 'Temp', valueType: 'xs:double', min: '0', max: '80' }]),
      { packageId: PID },
    );
    expect(plan.children[0]?.children[0]).toMatchObject({ dataType: 'String', value: '0..80' });
  });

  it('idShort가 없는 서브모델도 트리에서 사라지지 않는다', () => {
    const environment = {
      submodels: [{ modelType: 'Submodel', id: 'https://ktl/sm/x', submodelElements: [] }],
    } as unknown as Environment;
    const plan = planForPackage(environment, { packageId: PID, name: '이름없음' });
    expect(plan.children[0]?.name).toBe('https://ktl/sm/x');
    expect(plan.name).toBe('이름없음');
  });

  it('flattenVariables가 깊이와 무관하게 변수를 다 찾는다', () => {
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
