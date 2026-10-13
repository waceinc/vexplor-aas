/**
 * 값 편집 동작 — 값 · 이름 · semanticId · 첨부 · 대표 사진 · AssetInformation · 용어. 구조 편집은 useStructureActions.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import { type TreeNode } from '../model.js';
import type { Core } from './context.js';

export function useElementActions(c: Pick<Core, 'loadPackage' | 'packageId' | 'run' | 'setNotice' | 'setSelectedKey' | 'shell' | 'shellRevisions' | 'targetOf'>) {
  const { loadPackage, packageId, run, setNotice, setSelectedKey, shell, shellRevisions, targetOf } = c;
  /**
   * 값 표 저장 — 서브모델 JSON에 바뀐 값을 얹어 **한 번의 PATCH**로 보낸다.
   * 줄마다 patchValue를 부르면 revision이 어긋나 두 번째부터 409가 난다.
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
    // 저장 결과는 서버에서 다시 읽어 확인한다 — 화면 상태를 믿지 않는다
    if (done) await loadPackage(packageId);
  };
  /**
   * 이름(idShort) 바꾸기.
   *
   * 요소는 통째로 PUT하고(부분 갱신으로는 이름을 못 바꾼다), 서브모델은 PATCH한다.
   * 🔴 이름이 바뀌면 그 아래 모든 요소의 경로가 바뀐다 — 그래서 저장 뒤 **서버에서 다시 읽는다.**
   * 선택도 새 경로로 옮겨 준다. 안 그러면 방금 고친 요소가 화면에서 사라진다.
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
    // 트리에서의 자리는 그대로이므로(순서가 바뀌지 않는다) 같은 위치를 다시 고른다
    setSelectedKey(node.key);
    setNotice(fill(tr('이름을 「{0}」(으)로 바꿨습니다.'), { 0: nextName }));
    await loadPackage(packageId);
  };
  /**
   * 첨부 붙이기 — HandoverDocumentation의 매뉴얼 PDF가 여기로 들어간다.
   * 서버가 패키지 파트를 만들고 File.value까지 함께 고치므로, 화면은 다시 읽기만 하면 된다.
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
  /** semanticId는 $value로 못 고친다 — 요소 전체를 PUT한다 */
  const onSaveSemanticId = async (node: TreeNode, semanticId: string): Promise<void> => {
    if (!packageId) return;
    const reference = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: semanticId }] };
    // 🔴 서브모델도 semanticId를 가진다(표준 템플릿 IRI — KOSMO가 거기까지 본다). 요소와 달리 PATCH다
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
  /** 대표 사진 교체 — 임시 그림(/thumbnail.png)을 실제 장비 사진으로 */
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
