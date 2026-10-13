/**
 * 구성(공정 · 설비 · 부품) 동작 — 넣기 · 호기별 나눠 넣기 · 공정 층 · 이름만 설비 · 빼기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useHierarchyActions(c: Pick<Core, 'loadPackage' | 'packageId' | 'packages' | 'run' | 'setNotice' | 'setPackages'>) {
  const { loadPackage, packageId, packages, run, setNotice, setPackages } = c;
  /** 요소 추가 — 부모가 Submodel이면 바로 아래, 아니면 그 요소 아래에 붙인다 */
  /**
   * 공정에 설비를 넣는다.
   *
   * 🔴 고른 파일에서 이름과 Asset 주소를 **서버가 읽는다.** 화면이 옮겨 적지 않는 이유는
   *    그 값이 두 파일을 잇는 유일한 끈이기 때문이다 — 틀리면 조용히 끊긴다.
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
    // 🔴 수집 연결(AID)이 있는 설비를 ×n으로 넣으면, 그 값은 "그중 한 대"의 것일 뿐이다.
    //    대별 가동값이 목적이면 파일을 나눠야 한다 — 도구가 이 함정을 알아채고 말해 준다
    //    (2026-08-26 사용자 질문에서 확정된 Type/Instance 경계)
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
   * 호기별로 나눠 넣기 — ×n 대신 **원본을 복제한 파일**(이름_1…이름_n)을 각각 잇는다.
   * 각 호기는 서로 다른 개체라 복제 시 id·Asset 주소가 호기 이름으로 개명된다.
   * 원본의 주소를 같이 쓰면 안 된다 — "같은 자산이 n번"이라는 모순이 된다.
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
  /** 파일 없는 중간 마디 — 회사 파일 안의 「용접공정」. 이걸로 회사>공정>장비를 한 파일에 그린다 */
  const onAddHierarchyGroup = async (name: string, parentPath: string[]): Promise<void> => {
    if (!packageId) return;
    const added = await run(() =>
      api.addHierarchyNode(packageId, {
        name,
        group: true,
        ...(parentPath.length > 0 ? { parentPath } : {}),
      }),
    );
    if (!added) return;
    await loadPackage(packageId);
    setNotice(fill(tr('공정 「{0}」을(를) 만들었습니다. 그 줄의 「＋ 설비」로 설비를 넣으십시오.'), { 0: name }));
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
  /** 🔴 뺄 때 관계도 함께 빠진다(서버가 한다). 하나만 지우면 짝이 안 맞는 파일이 된다 */
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
