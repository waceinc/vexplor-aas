/**
 * Important: **one path convention**: the authoring UI (Part 2 idShortPath) and the OPC UA exposure (NodeId)
 * must call the same element by the same name.
 *
 * Why a test: the two conventions are written in separate files (tree construction in `model.ts`
 * and planning in `publish.ts`). Changing only one makes the element addressed via REST and
 * the one addressed via OPC UA diverge **without an error anywhere**, in a way that cannot be cross-checked on site.
 * This test catches that divergence.
 */
import { describe, expect, it } from 'vitest';
import type { Environment as CoreEnvironment } from '@aas/core';
import { flattenVariables, planForPackage } from '@aas/opcua';
import { buildTree, type Environment as WebEnvironment } from '../src/model.js';

/** Make both sides see the same file: the authoring UI shape and the core shape */
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
  it('the path the authoring UI addresses equals the OPC UA NodeId exactly', () => {
    const web = buildTree({
      shells: [],
      submodels: [SUBMODEL],
      conceptDescriptions: [],
    } as unknown as WebEnvironment);

    const plan = planForPackage({ submodels: [SUBMODEL] } as unknown as CoreEnvironment, {
      packageId: 'pkg-1',
    });

    /** Authoring UI side: collect idShortPath of value-bearing leaves only */
    const uiPaths: string[] = [];
    const walk = (nodes: readonly { idShortPath?: string; children: unknown[] }[]): void => {
      for (const node of nodes) {
        const children = node.children as { idShortPath?: string; children: unknown[] }[];
        if (children.length === 0 && node.idShortPath !== undefined) uiPaths.push(node.idShortPath);
        walk(children);
      }
    };
    walk(web as unknown as { idShortPath?: string; children: unknown[] }[]);

    /** OPC UA side: stripping the prefix must leave only the idShortPath */
    const prefix = 'pkg-1/https://ktl/sm/tech/';
    const uaPaths = flattenVariables(plan).map((node) => {
      expect(node.nodeId.startsWith(prefix)).toBe(true);
      return node.nodeId.slice(prefix.length);
    });

    expect(uaPaths).toEqual(uiPaths);
    // pin down what the convention actually is, so it is visible
    expect(uaPaths).toEqual([
      'ManufacturerName',
      'Motor.Speed',
      'Motor.Bearing.Temp',
      'Points[0]',
      'Points[1]',
    ]);
  });
});
