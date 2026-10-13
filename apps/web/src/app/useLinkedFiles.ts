/**
 * 공정(묶음) 파일을 열면 매달린 설비 파일들을 각 파일에서 읽어 와 트리 가지 · 지적 · revision 으로 쓴다.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { useEffect } from 'react';
import { api, type HierarchyNode } from '../api.js';
import { childrenOfHierarchy, type LinkedInfo, type Finding } from '../model.js';
import type { Base } from './context.js';

export function useLinkedFiles(c: Pick<Base, 'hierarchy' | 'packageId' | 'packages' | 'setLinked' | 'setLinkedFindings' | 'setLinkedRevisions'>) {
  const { hierarchy, packageId, packages, setLinked, setLinkedFindings, setLinkedRevisions } = c;
  // 🔴 공정을 열면 자식 설비의 서브모델을 각 파일에서 읽어 온다 — 트리가
  //    「A공정 → 장비 → 장비별 서브모델」로 그려지려면 이 내용이 필요하다.
  //    파일이 안 열려 있는 자식은 이름만 남는다(트리가 그 사실을 보여 준다).
  useEffect(() => {
    let alive = true;
    if (!hierarchy?.entryNode || hierarchy.children.length === 0) {
      setLinked([]);
      setLinkedFindings({});
      return undefined;
    }
    void (async () => {
      const revisionsByPackage: Record<string, Record<string, number>> = {};
      const findingsByPackage: Record<string, Finding[]> = {};
      // 🔴 재귀 — 자식이 또 계층 파일이면(회사→공정→장비) 그 자식까지 읽는다.
      //    깊이 3 제한 + 방문 기록으로 순환을 끊는다(서버도 막지만 화면은 화면대로 지킨다)
      const load = async (
        children: HierarchyNode[],
        depth: number,
        visited: Set<string>,
      ): Promise<LinkedInfo[]> => {
        const out: LinkedInfo[] = [];
        for (const child of children) {
          const info: LinkedInfo = { name: child.name, bulkCount: child.bulkCount, children: [] };
          if (child.globalAssetId === '') {
            // 그룹(파일 없는 중간 마디) — 같은 파일 안의 자식을 그대로 내려간다.
            // 파일을 건너는 것이 아니라 depth는 늘지 않는다
            info.group = true;
            info.children = await load(child.children, depth, visited);
          } else {
            const source = packages.find(
              (item) => item.globalAssetId === child.globalAssetId && item.packageId !== packageId,
            );
            if (source && depth < 3 && !visited.has(child.globalAssetId)) {
              try {
                const [list, revs, lintReport, conceptList] = await Promise.all([
                  api.submodels(source.packageId),
                  api.revisions(source.packageId),
                  api.lint(source.packageId),
                  api.conceptDescriptions(source.packageId),
                ]);
                revisionsByPackage[source.packageId] = revs.Submodel;
                findingsByPackage[source.packageId] = lintReport.findings;
                info.packageId = source.packageId;
                if (String(source.assetType ?? '').includes('/type/')) info.composite = true;
                info.submodels = list.result;
                info.concepts = conceptList.result;
                const nested = childrenOfHierarchy(
                  list.result.find((submodel) => submodel.idShort === 'HierarchicalStructures'),
                );
                info.children = await load(
                  nested as never,
                  depth + 1,
                  new Set([...visited, child.globalAssetId]),
                );
              } catch {
                // 읽기 실패 — 이름만 남긴다. 편집 흐름을 막을 일이 아니다
              }
            }
          }
          out.push(info);
        }
        return out;
      };
      const next = await load(hierarchy.children, 0, new Set());
      if (alive) {
        setLinked(next);
        setLinkedRevisions(revisionsByPackage);
        setLinkedFindings(findingsByPackage);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hierarchy, packages, packageId]);
  return {  };
}
