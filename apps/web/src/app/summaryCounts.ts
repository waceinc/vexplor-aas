/**
 * 파일 요약의 집계 — 공정(묶음) 파일에서 사람이 보는 구성과, 이어진 설비 파일까지 합친 내용 합계.
 * MiddlePane 에서 떼어 냈다(2026-10-14) — 계산과 주석은 옮기기 전 그대로다.
 */
import type { HierarchyNode, HierarchyView } from '../api.js';
import { countElements, type ConceptDescription, type LinkedInfo, type Submodel } from '../model.js';

export function summaryTotals(
  submodels: readonly Submodel[],
  concepts: readonly ConceptDescription[],
  linked: readonly LinkedInfo[],
): { submodels: number; elements: number; concepts: number; unopened: number } {
  let subCount = submodels.length;
  let elementCount = countElements(submodels);
  let conceptCount = concepts.length;
  let unopened = 0;
  const walk = (nodes: readonly LinkedInfo[]): void => {
    for (const node of nodes) {
      if (node.submodels) {
        subCount += node.submodels.length;
        elementCount += countElements(node.submodels);
        conceptCount += node.concepts?.length ?? 0;
        // 열린 설비 밑의 부품(BoM)은 그 설비 파일 안에 이미 셈해졌다 — 파일이 따로 있는 것이
        // 아니다. 예전엔 롤포밍기의 부품 3개를 「안 열린 설비 3건」으로 셌다(2026-09-30 검증).
        // 다만 열린 파일이 묶음(공정)이면 그 밑은 다른 파일이라 계속 센다
        if (!node.composite) continue;
      } else if (node.children.length === 0 && !node.group) {
        unopened += 1; // 파일이 안 열려 내용을 모른다 — 숨기지 말고 알린다
      }
      walk(node.children);
    }
  };
  walk(linked);
  return { submodels: subCount, elements: elementCount, concepts: conceptCount, unopened };
}

/** 사람이 보는 구성으로 센다 — 라인 · 그룹(공정·층)과 설비(참조), 대수 합 */
export function summaryComposition(hierarchy: HierarchyView): { lines: number; groups: number; assets: number; units: number } {
  let lines = 0;
  let groups = 0;
  let assets = 0;
  let units = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      if (node.globalAssetId === '' && node.line) lines += 1;
      else if (node.globalAssetId === '') groups += 1;
      else {
        assets += 1;
        units += node.bulkCount;
      }
      walk(node.children);
    }
  };
  walk(hierarchy.children);
  return { lines, groups, assets, units };
}
