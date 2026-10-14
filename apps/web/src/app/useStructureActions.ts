/**
 * 구조 편집 동작 — 요소·서브모델 만들기 · 다른 파일에서 가져오기 · 지우기 · 순서 · 복제 · 이력과 되돌리기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 값 편집은 useElementActions.
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import { localTime, type TreeNode } from '../model.js';
import type { Core } from './context.js';

export function useStructureActions(c: Pick<Core, 'expanded' | 'historyFor' | 'loadPackage' | 'packageId' | 'packages' | 'run' | 'setAdding' | 'setExpanded' | 'setHistoryEntries' | 'setHistoryFor' | 'setNotice' | 'setSelectedKey' | 'setSubmodelTarget' | 'shell' | 'submodelTarget' | 'targetOf'>) {
  const { expanded, historyFor, loadPackage, packageId, packages, run, setAdding, setExpanded, setHistoryEntries, setHistoryFor, setNotice, setSelectedKey, setSubmodelTarget, shell, submodelTarget, targetOf } = c;
  /** 서브모델 이력 열기 — 실수를 되돌리는 길 */
  const onShowHistory = async (node: TreeNode): Promise<void> => {
    if (!packageId) return;
    const entries = await run(() => api.history(packageId, node.submodelId));
    if (!entries) return;
    setHistoryEntries(entries.result);
    setHistoryFor({ submodelId: node.submodelId, label: node.label });
    setSelectedKey(undefined); // 편집기를 비켜 준다 — 이력이 그 자리에 나온다
  };
  const onRestore = async (changedAt: string): Promise<void> => {
    if (!packageId || !historyFor) return;
    if (!window.confirm(fill(tr('{0} 판으로 되돌립니다. 되돌리기 자체도 이력에 남습니다.'), { 0: localTime(changedAt) }))) return;
    const done = await run(async () => {
      await api.restore(packageId, historyFor.submodelId, changedAt);
      return true;
    });
    if (!done) return;
    setHistoryFor(undefined);
    await loadPackage(packageId);
    setNotice(tr('되돌렸습니다. 이 되돌리기도 이력에 남아 다시 되돌릴 수 있습니다.'));
  };
  const onCreateElement = async (parent: TreeNode, content: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    const { pid } = targetOf(parent);
    const done = await run(async () => {
      await api.createElement(pid, parent.submodelId, parent.idShortPath, content);
      return true;
    });
    if (!done) return;
    setAdding(undefined);
    setExpanded(new Set([...expanded, parent.key]));
    await loadPackage(packageId);
  };
  const onCreateSubmodel = async (content: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    // ⚙ 설비 컨텍스트에서 왔으면 그 설비 파일에 만든다 — 원본은 그 파일이다
    const pid = submodelTarget?.pid ?? packageId;
    const done = await run(async () => {
      const targetShell =
        pid === packageId ? shell : (await api.shells(pid)).result[0];
      if (!targetShell) throw new Error(tr('대상 파일에 AAS가 없습니다.'));
      await api.createSubmodel(pid, content);
      // AAS의 submodels[]에 참조를 함께 넣는다 — 빠뜨리면 어디에도 매달리지 않은 서브모델이 된다
      await api.addSubmodelRef(pid, targetShell.id, String(content['id']));
      return true;
    });
    if (!done) return;
    setAdding(undefined);
    if (submodelTarget) {
      setNotice(fill(tr('「{0}」에 서브모델을 만들었습니다.'), { 0: submodelTarget.assetName }));
      setSubmodelTarget(undefined);
    }
    await loadPackage(packageId);
  };
  const onImport = async (
    sourcePackageId: string,
    submodelId: string,
    onDuplicate: 'reject' | 'replace' | 'alongside' = 'reject',
  ): Promise<void> => {
    if (!packageId) return;
    const result = await run(() => api.importSubmodel(packageId, sourcePackageId, submodelId, onDuplicate));
    if (!result) return;
    setAdding(undefined);
    const sourceName = packages.find((item) => item.packageId === sourcePackageId)?.name ?? tr('원본 파일');
    setNotice(
      fill(tr('가져왔습니다: {0}'), { 0: result.submodelId }) +
        (result.replaced ? fill(tr(' · 같은 이름의 옛것 {0}건을 지웠습니다'), { 0: result.replaced.length }) : '') +
        (result.idShort ? fill(tr(' · 이름은 「{0}」로 두었습니다'), { 0: result.idShort }) : '') +
        (result.copiedConceptDescriptions > 0
          ? fill(tr(' · ConceptDescription {0}건 동반'), { 0: result.copiedConceptDescriptions })
          : '') +
        // 🔴 실전 검증(2026-09-07): 가져온 명판의 제조사·일련번호는 **원본 설비 것**인데 위반 0건이라
        //    다 된 줄 알기 쉽다. 값을 바꿔야 한다는 것을 여기서 말해 준다
        fill(tr(' — 값은 「{0}」의 것입니다. 트리에서 골라 이 설비 값으로 바꾸십시오.'), { 0: sourceName }),
    );
    await loadPackage(packageId);
  };
  const onDelete = async (node: TreeNode): Promise<void> => {
    if (!packageId) return;
    const what = node.modelType === 'Submodel' ? fill(tr('서브모델 {0}'), { 0: node.label }) : fill(tr('요소 {0}'), { 0: node.label });
    if (!globalThis.confirm(fill(tr('{0}을(를) 지웁니다. 잘못 지웠으면 「↶ 되돌리기」(Ctrl+Z)로 돌아옵니다.'), { 0: what }))) {
      return;
    }
    const done = await run(async () => {
      if (node.modelType === 'Submodel') {
        // 🔴 다른 파일의 서브모델 통째 삭제는 여기서 하지 않는다 — AAS 참조 정리까지
        //    그 파일 문맥에서 해야 한다. 요소 편집과 달리 파일 구조를 바꾸는 일이다
        if (node.linkedPackageId !== undefined) {
          setNotice(tr('다른 파일의 서브모델은 그 파일을 열어 지우십시오.'));
          return false;
        }
        if (shell) await api.removeSubmodelRef(packageId, shell.id, node.submodelId).catch(() => undefined);
        await api.deleteSubmodel(packageId, node.submodelId);
      } else {
        await api.deleteElement(targetOf(node).pid, node.submodelId, node.idShortPath!);
      }
      return true;
    });
    if (!done) return;
    setSelectedKey(undefined);
    await loadPackage(packageId);
  };
  /**
   * 순서 바꾸기·복제 — Package Explorer에 있고 우리에겐 없던 두 가지(2026-09-04 검토).
   * 트리 key는 JSON Pointer라 옮긴 뒤의 자리를 계산할 수 있다 — 마지막 마디의 번호만 바뀐다.
   */
  const shiftedKey = (key: string, by: number): string =>
    key.replace(/\/(\d+)$/, (_, n: string) => `/${Number(n) + by}`);

  /** 형제 안에서 옮긴다 — `{offset}`은 한 칸(Alt+↑↓·메뉴), `{to}`는 끌어다 놓은 자리 */
  const onMove = async (node: TreeNode, move: { offset: -1 | 1 } | { to: number }): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const from = Number(/\/(\d+)$/.exec(node.key)?.[1] ?? NaN);
    const to = 'to' in move ? move.to : from + move.offset;
    if (Number.isNaN(from) || to === from || to < 0) return;
    const done = await run(async () => {
      await api.moveElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        move,
        targetOf(node).revision,
      );
      return true;
    });
    if (!done) return;
    setSelectedKey(shiftedKey(node.key, to - from));
    await loadPackage(packageId);
  };
  const onDuplicate = async (node: TreeNode): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const made = await run(() =>
      api.duplicateElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        targetOf(node).revision,
      ),
    );
    if (!made) return;
    setSelectedKey(shiftedKey(node.key, 1));
    setNotice(
      made.idShort
        ? fill(tr('「{0}」을(를) 「{1}」(으)로 복제했습니다 — 이름과 값을 고쳐 쓰십시오.'), { 0: node.label, 1: made.idShort })
        : fill(tr('「{0}」을(를) 바로 아래에 복제했습니다.'), { 0: node.label }),
    );
    await loadPackage(packageId);
  };
  return { onShowHistory, onRestore, onCreateElement, onCreateSubmodel, onImport, onDelete, shiftedKey, onMove, onDuplicate };
}
