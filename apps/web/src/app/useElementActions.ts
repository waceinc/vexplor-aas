/**
 * Value editing actions — value · name · semanticId · attachment · thumbnail · AssetInformation · concept. Structural edits live in useStructureActions.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import { type TreeNode } from '../model.js';
import type { Core } from './context.js';

export function useElementActions(c: Pick<Core, 'loadPackage' | 'packageId' | 'run' | 'setNotice' | 'setSelectedKey' | 'shell' | 'shellRevisions' | 'targetOf'>) {
  const { loadPackage, packageId, run, setNotice, setSelectedKey, shell, shellRevisions, targetOf } = c;
  /**
   * Save the value table — apply changed values onto the submodel JSON and send **one PATCH**.
   * Calling patchValue per row makes revisions drift and returns 409 from the second call on.
   */
  const onBulkSaveValues = async (
    node: TreeNode,
    content: Record<string, unknown>,
  ): Promise<void> => {
    if (!packageId) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      await api.patchSubmodel(pid, node.submodelId, content, revision);
      return true;
    });
    if (!done) return;
    setNotice(tr('값을 저장했습니다.'));
    await loadPackage(packageId);
  };
  const onSave = async (node: TreeNode, value: unknown): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      await api.patchValue(pid, node.submodelId, node.idShortPath!, value, revision);
      return true;
    });
    // Verify the save by re-reading from the server — do not trust screen state
    if (done) await loadPackage(packageId);
  };
  /**
   * Rename (idShort).
   *
   * Elements are PUT whole (a partial update cannot rename); submodels are PATCHed.
   * Important: a rename changes the path of every element beneath it — so **re-read from the server** after saving.
   * Move the selection to the new path too, or the element just edited vanishes from the screen.
   */
  const onRename = async (node: TreeNode, nextName: string): Promise<void> => {
    if (!packageId) return;
    const { pid, revision } = targetOf(node);
    const done = await run(async () => {
      if (node.modelType === 'Submodel') {
        await api.patchSubmodel(pid, node.submodelId, { idShort: nextName }, revision);
      } else {
        if (!node.idShortPath) return false;
        await api.putElement(
          pid,
          node.submodelId,
          node.idShortPath,
          { ...node.node, idShort: nextName },
          revision,
        );
      }
      return true;
    });
    if (!done) return;
    // Its place in the tree is unchanged (order does not change), so select the same position again
    setSelectedKey(node.key);
    setNotice(fill(tr('이름을 「{0}」(으)로 바꿨습니다.'), { 0: nextName }));
    await loadPackage(packageId);
  };
  /**
   * Attach a file — HandoverDocumentation manual PDFs go here.
   * The server creates the package part and updates File.value too, so the screen only needs to re-read.
   */
  const onUploadAttachment = async (node: TreeNode, file: File): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const done = await run(async () => {
      await api.putAttachment(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        file,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) {
      setNotice(fill(tr('「{0}」을(를) 붙였습니다. 내려받기한 AASX 안에 함께 들어갑니다.'), { 0: file.name }));
      await loadPackage(packageId);
    }
  };
  const onDownloadAttachment = async (node: TreeNode, filename: string): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    await run(() =>
      api.downloadAttachment(targetOf(node).pid, node.submodelId, node.idShortPath!, filename),
    );
  };
  const onDeleteAttachment = async (node: TreeNode): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    if (!globalThis.confirm(tr('붙어 있는 파일을 지웁니다. 계속할까요?'))) return;
    const done = await run(async () => {
      await api.deleteAttachment(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) await loadPackage(packageId);
  };
  /** semanticId cannot be changed via $value — PUT the whole element */
  const onSaveSemanticId = async (node: TreeNode, semanticId: string): Promise<void> => {
    if (!packageId) return;
    const reference = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: semanticId }] };
    // Important: submodels also carry a semanticId (the standard template IRI — KOSMO checks it). Unlike elements it is a PATCH
    if (node.modelType === 'Submodel') {
      const done = await run(async () => {
        await api.patchSubmodel(targetOf(node).pid, node.submodelId, { semanticId: reference }, targetOf(node).revision);
        return true;
      });
      if (done) await loadPackage(packageId);
      return;
    }
    if (!node.idShortPath) return;
    const next = { ...node.node, semanticId: reference };
    const done = await run(async () => {
      await api.putElement(
        targetOf(node).pid,
        node.submodelId,
        node.idShortPath!,
        next,
        targetOf(node).revision,
      );
      return true;
    });
    if (done) await loadPackage(packageId);
  };
  /** Replace the thumbnail — the placeholder (/thumbnail.png) with a real equipment photo */
  const onUploadThumbnail = async (file: File): Promise<void> => {
    if (!packageId || !shell) return;
    const done = await run(async () => {
      await api.putThumbnail(packageId, shell.id, file, shellRevisions[shell.id]);
      return true;
    });
    if (!done) return;
    setNotice(fill(tr('대표 사진을 「{0}」(으)로 바꿨습니다. 내려받기한 AASX에 함께 들어갑니다.'), { 0: file.name }));
    await loadPackage(packageId);
  };
  const onSaveAssetInformation = async (info: Record<string, unknown>): Promise<void> => {
    if (!packageId || !shell) return;
    const done = await run(async () => {
      await api.putAssetInformation(packageId, shell.id, info, shellRevisions[shell.id]);
      return true;
    });
    if (done) await loadPackage(packageId);
  };
  const onSaveConcept = async (concept: Record<string, unknown>): Promise<void> => {
    if (!packageId) return;
    const done = await run(async () => {
      await api.putConceptDescription(packageId, concept);
      return true;
    });
    if (!done) return;
    setNotice(fill(tr('용어 「{0}」의 정의를 저장했습니다.'), { 0: String(concept['idShort'] ?? concept['id']) }));
    await loadPackage(packageId);
  };
  return { onBulkSaveValues, onSave, onRename, onUploadAttachment, onDownloadAttachment, onDeleteAttachment, onSaveSemanticId, onUploadThumbnail, onSaveAssetInformation, onSaveConcept };
}
