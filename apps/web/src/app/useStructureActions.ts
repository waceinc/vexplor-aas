/**
 * Structural editing actions — create elements/submodels · import from another file · delete · order · duplicate · history and undo.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move. Value editing is in useElementActions.
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import { localTime, type TreeNode } from '../model.js';
import type { Core } from './context.js';

export function useStructureActions(c: Pick<Core, 'expanded' | 'historyFor' | 'loadPackage' | 'packageId' | 'packages' | 'run' | 'setAdding' | 'setExpanded' | 'setHistoryEntries' | 'setHistoryFor' | 'setNotice' | 'setSelectedKey' | 'setSubmodelTarget' | 'shell' | 'submodelTarget' | 'targetOf'>) {
  const { expanded, historyFor, loadPackage, packageId, packages, run, setAdding, setExpanded, setHistoryEntries, setHistoryFor, setNotice, setSelectedKey, setSubmodelTarget, shell, submodelTarget, targetOf } = c;
  /** Open submodel history — the way to undo mistakes */
  const onShowHistory = async (node: TreeNode): Promise<void> => {
    if (!packageId) return;
    const entries = await run(() => api.history(packageId, node.submodelId));
    if (!entries) return;
    setHistoryEntries(entries.result);
    setHistoryFor({ submodelId: node.submodelId, label: node.label });
    setSelectedKey(undefined); // step the editor aside — the history appears in its place
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
    // Coming from a ⚙ equipment context, create it in that equipment file — that file is the source
    const pid = submodelTarget?.pid ?? packageId;
    const done = await run(async () => {
      const targetShell =
        pid === packageId ? shell : (await api.shells(pid)).result[0];
      if (!targetShell) throw new Error(tr('대상 파일에 AAS가 없습니다.'));
      await api.createSubmodel(pid, content);
      // Add the reference to the AAS's submodels[] too — omit it and the submodel hangs off nothing
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
        // Important: field test (2026-09-07): the manufacturer and serial number on an imported nameplate are **the source equipment's**, yet with
        //    0 violations it is easy to think it is done. Say here that the values must be changed
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
        // Important: deleting another file's whole submodel is not done here — cleaning up AAS references
        //    must happen in that file's context. Unlike element edits, it changes the file structure
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
   * Reorder · duplicate — two things Package Explorer has and we lacked (reviewed 2026-09-04).
   * Tree keys are JSON Pointers, so the place after a move can be computed — only the last segment's index changes.
   */
  const shiftedKey = (key: string, by: number): string =>
    key.replace(/\/(\d+)$/, (_, n: string) => `/${Number(n) + by}`);

  /** Move within siblings — `{offset}` is one step (Alt+↑↓ · menu), `{to}` is the drop position */
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
