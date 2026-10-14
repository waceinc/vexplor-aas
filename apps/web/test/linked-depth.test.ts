/**
 * 연결 설비 가지의 깊이 — AAS 노드 바로 아래(AssetInformation 과 같은 단계)에 놓인다.
 * 예전에는 주소 조각을 하나 더 세어(맨 앞 빈 조각) 이 가지만 한 단계 더 들어가 그려졌다(2026-10-14 간격 검수).
 */
import { describe, expect, it } from 'vitest';
import { buildLinkedAsset } from '../src/model/linked.js';

describe('연결 설비 가지의 깊이', () => {
  it('맨 위 가지는 1, 그 아래는 2', () => {
    const root = buildLinkedAsset({ name: 'Press', bulkCount: 1, group: true, children: [{ name: 'Robot', bulkCount: 1, children: [] }] } as never);
    expect(root.depth).toBe(1);
    expect(root.children[0]?.depth).toBe(2);
  });
});
