/**
 * When a process (bundle) file is opened, read the attached equipment files from each file and use them as tree branches · findings · revisions.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { useEffect } from 'react';
import { api, type HierarchyNode } from '../api.js';
import { childrenOfHierarchy, type LinkedInfo, type Finding } from '../model.js';
import type { Base } from './context.js';

export function useLinkedFiles(c: Pick<Base, 'hierarchy' | 'packageId' | 'packages' | 'setLinked' | 'setLinkedFindings' | 'setLinkedRevisions'>) {
  const { hierarchy, packageId, packages, setLinked, setLinkedFindings, setLinkedRevisions } = c;
  // Important: opening a process reads the child equipment's submodels from each file — the tree needs this
  //    content to draw "process A → equipment → per-equipment submodels".
  //    Children whose file is not open keep only their name (the tree shows that).
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
      // Important: recursive — if a child is itself a hierarchy file (company → process → equipment), read its children too.
      //    Depth limit 3 + a visited set break cycles (the server blocks them too, but the screen guards on its own)
      const load = async (
        children: HierarchyNode[],
        depth: number,
        visited: Set<string>,
      ): Promise<LinkedInfo[]> => {
        const out: LinkedInfo[] = [];
        for (const child of children) {
          const info: LinkedInfo = { name: child.name, bulkCount: child.bulkCount, children: [] };
          if (child.globalAssetId === '') {
            // Group (an intermediate node without a file) — descend into children within the same file.
            // This does not cross into another file, so depth does not increase
            info.group = true;
            if (child.line) info.line = true;
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
                // Read failed — keep only the name. This must not block the editing flow
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
