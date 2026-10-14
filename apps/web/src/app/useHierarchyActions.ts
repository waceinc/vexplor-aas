/**
 * Composition (process · equipment · component) actions — insert · insert split per unit · process level · name-only equipment · remove.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useHierarchyActions(c: Pick<Core, 'loadPackage' | 'packageId' | 'packages' | 'run' | 'setNotice' | 'setPackages'>) {
  const { loadPackage, packageId, packages, run, setNotice, setPackages } = c;
  /** Add an element — directly under the parent if it is a Submodel, otherwise under that element */
  /**
   * Insert equipment into a process.
   *
   * Important: **the server reads** the name and Asset address from the chosen file. The screen does not copy them over
   *    because that value is the only string linking the two files — if it is wrong the link breaks silently.
   */
  const onAddHierarchyNode = async (
    sourcePackageId: string,
    bulkCount = 1,
    parentPath: string[] = [],
  ): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        sourcePackageId,
        ...(bulkCount > 1 ? { bulkCount } : {}),
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    // Important: inserting equipment with a collection connection (AID) as ×n means the values belong to "one of them" only.
    //    If per-unit operating values are the goal, the files must be split — the tool notices this trap and says so
    //    (the Type/Instance boundary settled from a user question on 2026-08-26)
    let caution = '';
    if (bulkCount > 1) {
      const hasAid = await api
        .submodels(sourcePackageId)
        .then((list) => list.result.some((sm) => sm.idShort === 'AssetInterfacesDescription'))
        .catch(() => false);
      if (hasAid) {
        caution = fill(
          tr(' 주의: 이 설비에는 수집 연결(AID)이 있습니다 — ×{0}로 넣으면 수집값이 어느 대의 것인지 구분되지 않습니다. 대별 가동값이 목적이면 대마다 파일을 나누십시오.'),
          { 0: bulkCount },
        );
      }
    }
    setNotice(
      (parentPath.length > 0
        ? fill(tr('「{0}」을(를) {1} 밑에 넣었습니다.'), { 0: added.name, 1: parentPath.join(' → ') })
        : fill(tr('「{0}」을(를) 넣었습니다.'), { 0: added.name })) + caution,
    );
  };
  /**
   * Insert split per unit — instead of ×n, link **a file cloned from the original** (name_1…name_n) for each.
   * Each unit is a distinct object, so cloning renames the id and Asset address after the unit name.
   * Reusing the original's address is not allowed — it would be the contradiction "the same asset n times".
   */
  const onAddHierarchySplit = async (
    sourcePackageId: string,
    count: number,
    parentPath: string[],
  ): Promise<void> => {
    if (!packageId) return;
    const source = packages.find((item) => item.packageId === sourcePackageId);
    const base = source?.assetName ?? source?.name?.replace(/\.aasx$/i, '') ?? 'Unit';
    const failed: string[] = [];
    for (let unit = 1; unit <= count; unit += 1) {
      const name = `${base}_${unit}`;
      try {
        const existing = packages.find((p) => p.assetName === name);
        const clone = existing ?? (await api.clonePackage(sourcePackageId, name));
        await api.addHierarchyNode(packageId, {
          sourcePackageId: clone.packageId,
          ...(parentPath.length > 0 ? { parentPath } : {}),
        });
      } catch {
        failed.push(name);
      }
    }
    const list = await api.listPackages();
    setPackages(list.result);
    await loadPackage(packageId);
    setNotice(
      failed.length > 0
        ? fill(tr('호기별로 넣다 실패: {0}'), { 0: failed.join(' · ') })
        : fill(tr('{0}_1 … _{1} 파일을 복제해 나눠 넣었습니다 — 서브모델까지 그대로 담겨 있습니다. 호기마다 값·수집 주소를 따로 고치면 됩니다.'), { 0: base, 1: count }),
    );
  };
  /** An intermediate node without a file — "welding process" inside a company file. Draws company > process > equipment in one file */
  const onAddHierarchyGroup = async (name: string, parentPath: string[], line = false): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        name,
        group: true,
        ...(line ? { line: true } : {}),
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    setNotice(
      line
        ? fill(tr('라인 「{0}」을(를) 만들었습니다. 그 줄의 「＋ 공정」으로 공정을 넣으십시오.'), { 0: name })
        : fill(tr('공정 「{0}」을(를) 만들었습니다. 그 줄의 「＋ 설비」로 설비를 넣으십시오.'), { 0: name }),
    );
  };
  const onAddHierarchyManual = async (
    name: string,
    globalAssetId: string,
    bulkCount: number,
    parentPath: string[] = [],
  ): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        name,
        globalAssetId,
        bulkCount,
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    setNotice(fill(tr('「{0}」을(를) 넣었습니다.'), { 0: name }));
  };
  /** Important: removing also removes the relationship (the server does it). Deleting only one side leaves mismatched files */
  const onRemoveHierarchyNode = async (name: string, parentPath: string[] = []): Promise<void> => {
    if (!packageId) return;
    if (!window.confirm(fill(tr('「{0}」을(를) 이 목록에서 뺍니다. 설비 파일 자체는 지워지지 않습니다.'), { 0: name }))) {
      return;
    }
    const done = await run(async () => {
      await api.removeHierarchyNode(packageId, name, parentPath);
      return true;
    });
    if (!done) return;
    await loadPackage(packageId);
    setNotice(fill(tr('「{0}」을(를) 뺐습니다.'), { 0: name }));
  };
  return { onAddHierarchyNode, onAddHierarchySplit, onAddHierarchyGroup, onAddHierarchyManual, onRemoveHierarchyNode };
}
