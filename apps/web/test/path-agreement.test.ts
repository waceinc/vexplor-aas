/**
 * 🔴 **경로 규약 하나 맞추기** — 저작 UI(Part 2 idShortPath)와 OPC UA 노출(NodeId)이
 * 같은 요소를 같은 이름으로 불러야 한다.
 *
 * 왜 시험까지 두는가: 두 규약은 서로 다른 파일에 각각 적혀 있다(`model.ts`의 트리 구성과
 * `publish.ts`의 계획 세우기). 한쪽만 고치면 **아무 데서도 오류가 나지 않은 채**
 * REST로 짚은 요소와 OPC UA로 짚은 요소가 어긋난다 — 현장에서 대조가 안 되는 형태로.
 * 그 어긋남을 여기서 잡는다.
 */
import { describe, expect, it } from 'vitest';
import type { Environment as CoreEnvironment } from '@aas/core';
import { flattenVariables, planForPackage } from '@aas/opcua';
import { buildTree, type Environment as WebEnvironment } from '../src/model.js';

/** 두 쪽이 같은 파일을 보게 — 저작 UI 모양과 코어 모양 */
const SUBMODEL = {
  modelType: 'Submodel',
  id: 'https://ktl/sm/tech',
  idShort: 'TechnicalData',
  submodelElements: [
    { modelType: 'Property', idShort: 'ManufacturerName', valueType: 'xs:string', value: 'a' },
    {
      modelType: 'SubmodelElementCollection',
      idShort: 'Motor',
      value: [
        { modelType: 'Property', idShort: 'Speed', valueType: 'xs:double', value: '1' },
        {
          modelType: 'SubmodelElementCollection',
          idShort: 'Bearing',
          value: [{ modelType: 'Property', idShort: 'Temp', valueType: 'xs:double', value: '2' }],
        },
      ],
    },
    {
      modelType: 'SubmodelElementList',
      idShort: 'Points',
      value: [
        { modelType: 'Property', valueType: 'xs:double', value: '3' },
        { modelType: 'Property', idShort: '무시됨', valueType: 'xs:double', value: '4' },
      ],
    },
  ],
};

describe('idShortPath ↔ NodeId', () => {
  it('저작 UI가 짚는 경로와 OPC UA NodeId가 정확히 같다', () => {
    const web = buildTree({
      shells: [],
      submodels: [SUBMODEL],
      conceptDescriptions: [],
    } as unknown as WebEnvironment);

    const plan = planForPackage({ submodels: [SUBMODEL] } as unknown as CoreEnvironment, {
      packageId: 'pkg-1',
    });

    /** 저작 UI 쪽 — 값이 든 잎의 idShortPath만 모은다 */
    const uiPaths: string[] = [];
    const walk = (nodes: readonly { idShortPath?: string; children: unknown[] }[]): void => {
      for (const node of nodes) {
        const children = node.children as { idShortPath?: string; children: unknown[] }[];
        if (children.length === 0 && node.idShortPath !== undefined) uiPaths.push(node.idShortPath);
        walk(children);
      }
    };
    walk(web as unknown as { idShortPath?: string; children: unknown[] }[]);

    /** OPC UA 쪽 — 접두사를 떼면 idShortPath만 남아야 한다 */
    const prefix = 'pkg-1/https://ktl/sm/tech/';
    const uaPaths = flattenVariables(plan).map((node) => {
      expect(node.nodeId.startsWith(prefix)).toBe(true);
      return node.nodeId.slice(prefix.length);
    });

    expect(uaPaths).toEqual(uiPaths);
    // 규약이 실제로 무엇인지 눈에 보이게 박아 둔다
    expect(uaPaths).toEqual([
      'ManufacturerName',
      'Motor.Speed',
      'Motor.Bearing.Temp',
      'Points[0]',
      'Points[1]',
    ]);
  });
});
