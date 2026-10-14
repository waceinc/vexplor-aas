/**
 * Depth of the linked-equipment branch: sits directly under the AAS node (same level as AssetInformation).
 * Previously one extra address segment (the leading empty one) was counted, drawing only this branch one level deeper (2026-10-14 spacing review).
 */
import { describe, expect, it } from 'vitest';
import { buildLinkedAsset } from '../src/model/linked.js';

describe('depth of the linked-equipment branch', () => {
  it('top branch is 1, below it is 2', () => {
    const root = buildLinkedAsset({ name: 'Press', bulkCount: 1, group: true, children: [{ name: 'Robot', bulkCount: 1, children: [] }] } as never);
    expect(root.depth).toBe(1);
    expect(root.children[0]?.depth).toBe(2);
  });
});
