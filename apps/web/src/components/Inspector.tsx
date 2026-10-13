/**
 * 속성 편집.
 *
 * 값 수정은 Part 2의 `$value` PATCH 한 길로만 나간다.
 * A안(파일이 원본)에서 이 편집은 곧 파일에 남는 편집이다 — 되돌릴 수 없는 실수가 되지 않도록
 * 저장 전까지는 화면 상태만 바꾸고, 저장 결과는 서버에서 다시 읽어 확인한다.
 *
 * 2026-10-13 컴포넌트화 — 편집기마다 inspector/ 의 부품으로 나눴다. 여기는 무엇을 보일지만 정한다.
 */
import { Fragment, useMemo } from 'react';
import type { Policy } from '../api.js';
import { EDITABLE_VALUE_TYPES, type TreeNode } from '../model.js';
import { AssetInfoEditor } from './inspector/AssetInfoEditor.js';
import { AttachmentEditor } from './inspector/AttachmentEditor.js';
import { BulkValues } from './inspector/BulkValues.js';
import { ConceptEditor } from './inspector/ConceptEditor.js';
import { ElementActions } from './inspector/ElementActions.js';
import { ElementHint } from './inspector/ElementHint.js';
import { renameable } from './inspector/helpers.js';
import { InspectorFacts } from './inspector/InspectorFacts.js';
import { RenameEditor } from './inspector/RenameEditor.js';
import { SemanticEditor } from './inspector/SemanticEditor.js';
import { ValueEditor } from './inspector/ValueEditors.js';

interface Props {
  node?: TreeNode;
  /**
   * 선택 해제 — 편집기를 닫고 요약·「무엇으로 이루어졌나」·수집 화면으로 돌아간다.
   * 🔴 이게 없어서 트리를 한 번 고르면 설비 추가 화면으로 **돌아올 방법이 없었다**(실측).
   */
  onClose?: () => void;
  /** 이 요소까지의 길(상위 이름들) — "어디의 요소인지"가 제목만으로는 안 보인다 */
  trail?: readonly string[];
  busy: boolean;
  onSave: (node: TreeNode, value: unknown) => void;
  /** 이 노드 아래에 요소를 만들 수 있으면 준다 */
  onAddChild?: (node: TreeNode) => void;
  /** 이름(idShort) 바꾸기. 리스트 자식은 주지 않는다 */
  onRename?: (node: TreeNode, name: string) => void;
  /** File·Blob 요소에 실제 파일을 붙인다 (매뉴얼 PDF·도면) */
  onUploadAttachment?: (node: TreeNode, file: File) => void;
  onDownloadAttachment?: (node: TreeNode, filename: string) => void;
  onDeleteAttachment?: (node: TreeNode) => void;
  onDelete?: (node: TreeNode) => void;
  /** 바로 아래에 사본 — 같은 구조를 여러 벌 채울 때 */
  onDuplicate?: (node: TreeNode) => void;
  /** valueType처럼 $value로는 못 바꾸는 속성을 고친다 — 요소 통째 교체 */
  onChangeValueType?: (node: TreeNode, valueType: string) => void;
  /** 서브모델 변경 이력을 연다 — 실수를 되돌리는 길 */
  onShowHistory?: (node: TreeNode) => void;
  /**
   * 값 한꺼번에 저장 — 서브모델을 고르면 안의 값(Property·MLP·Range)을 표로 입력한다.
   * 요소를 하나씩 눌러 40번 저장하는 것은 사람이 할 일이 아니다(초보자 여정 후속 제안).
   * 한 번의 PATCH로 저장한다 — 줄마다 쓰면 revision이 어긋나 두 번째부터 409가 난다.
   */
  onBulkSaveValues?: (node: TreeNode, content: Record<string, unknown>) => void;
  /** 이 요소가 다른 파일의 것이면 그 파일 이름 — 어디를 고치는 중인지 알려야 한다 */
  linkedFileName?: string;
  /** semanticId 검사에 쓴다 (M4 축소판) */
  policy?: Policy;
  conceptIds?: ReadonlySet<string>;
  onSaveSemanticId?: (node: TreeNode, semanticId: string) => void;
  /** AssetInformation 저장 — assetKind·globalAssetId */
  onSaveAssetInformation?: (info: Record<string, unknown>) => void;
  /** 용어(CD) 정의 저장 — 통째로 바뀐 CD를 넘긴다 */
  onSaveConcept?: (concept: Record<string, unknown>) => void;
  /**
   * 대표 사진 올리기 — 뼈대의 임시 그림을 실제 장비 사진으로 바꾸는 자리.
   * 🔴 안내문은 "AssetInformation에서 바꿀 수 있다"고 해 왔는데 정작 올리는 단추가
   *    없었다(초보자 여정 실측, 2026-08-26). 서버 API는 처음부터 있었다.
   */
  onUploadThumbnail?: (file: File) => void;
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
  t: (text: string) => string;
}

export function Inspector(props: Props): React.JSX.Element {
  const { node, busy, t } = props;
  /**
   * 「지금 무엇을 보고 있나」의 **지문**.
   *
   * 🔴 입력칸 초기화를 `[node]`(객체 동일성)에 걸어 두었더니, 화면이 트리를 **다시 만들기만 해도**
   *    입력하던 값이 지워졌다. 트리는 `shells·submodels·concepts·hierarchy·linked` 중 하나만
   *    바뀌어도 통째로 새로 만들어지고, 그것들은 파일을 열 때 **여러 번에 나눠** 들어온다.
   *    사람이 그 사이에 타자를 치고 있으면 그대로 날아간다 — 테스트가 부하에서 간헐적으로
   *    떨어지던 것이 이 현상이었다(2026-10-02에 원인을 잡았다).
   *
   * 그래서 **내용이 실제로 달라졌을 때만** 초기화한다. 저장·되돌리기·이력 복원은 내용이
   * 바뀌므로 그대로 초기화되고, 트리만 새로 만들어진 경우는 건드리지 않는다.
   * 지문 계산은 객체가 바뀔 때만 한다 — 매 렌더 직렬화하면 그것대로 낭비다.
   */
  const signature = useMemo(
    () => `${node?.pointer ?? ''} :: ${JSON.stringify(node?.node ?? null)}`,
    [node],
  );

  if (!node) return <div className="inspector empty" />;

  const raw = node.node;
  const editable = node.idShortPath !== undefined && EDITABLE_VALUE_TYPES.has(node.modelType);
  const { onSave, onBulkSaveValues, onSaveAssetInformation, onSaveConcept, onRename, onUploadAttachment, onSaveSemanticId, policy } = props;

  return (
    <div className="inspector">
      <InspectorFacts
        node={node}
        busy={busy}
        t={t}
        {...(props.trail ? { trail: props.trail } : {})}
        {...(props.linkedFileName ? { linkedFileName: props.linkedFileName } : {})}
        {...(props.onClose ? { onClose: props.onClose } : {})}
        {...(props.onShowHistory ? { onShowHistory: props.onShowHistory } : {})}
        {...(props.onChangeValueType ? { onChangeValueType: props.onChangeValueType } : {})}
      />

      {/* 내용이 바뀌면(다른 요소 · 저장 뒤 다시 읽기) 편집기들을 새로 그려 입력칸을 처음 값으로 — 위 지문 설명 */}
      <Fragment key={signature}>
        {editable && <ValueEditor node={node} busy={busy} onSave={onSave} t={t} />}

        {/* AssetInformation은 아래에 편집칸이 있으므로 "편집 대상이 아니다"라고 하면 안 된다 */}
        {!editable && node.modelType !== 'ConceptDescriptionGroup' && node.modelType !== 'AssetInformation' && (
          <ElementHint node={node} />
        )}

        {node.modelType === 'Submodel' && onBulkSaveValues && (
          <BulkValues node={node} busy={busy} onBulkSaveValues={onBulkSaveValues} t={t} />
        )}

        {node.modelType === 'AssetInformation' && onSaveAssetInformation && (
          <AssetInfoEditor
            raw={raw}
            busy={busy}
            onSaveAssetInformation={onSaveAssetInformation}
            {...(props.onUploadThumbnail ? { onUploadThumbnail: props.onUploadThumbnail } : {})}
            t={t}
          />
        )}

        {node.modelType === 'ConceptDescription' && onSaveConcept && (
          <ConceptEditor raw={raw} busy={busy} onSaveConcept={onSaveConcept} t={t} />
        )}

        {/*
          이름(idShort) 바꾸기.
          🔴 리스트(SubmodelElementList) 자식은 뺀다 — 그 자리는 순서로 가리키고,
          이름을 붙이면 표준 제약(AASd-120) 위반이 된다. 경로 마지막이 `[n]`이면 리스트 자식이다.
        */}
        {onRename && renameable(node) && <RenameEditor node={node} busy={busy} onRename={onRename} t={t} />}

        {/*
          첨부 — File·Blob이 가리키는 실제 파일.
          HandoverDocumentation의 매뉴얼 PDF가 제출물의 실체라, 값(경로)만 고쳐서는 안 되고
          **파일 자체를 넣을 수 있어야** 한다.
        */}
        {(node.modelType === 'File' || node.modelType === 'Blob') && node.idShortPath !== undefined && onUploadAttachment && (
          <AttachmentEditor
            node={node}
            busy={busy}
            onUploadAttachment={onUploadAttachment}
            {...(props.onDownloadAttachment ? { onDownloadAttachment: props.onDownloadAttachment } : {})}
            {...(props.onDeleteAttachment ? { onDeleteAttachment: props.onDeleteAttachment } : {})}
            t={t}
          />
        )}

        {onSaveSemanticId && policy && (node.idShortPath !== undefined || node.modelType === 'Submodel') && (
          <SemanticEditor
            node={node}
            busy={busy}
            policy={policy}
            {...(props.conceptIds ? { conceptIds: props.conceptIds } : {})}
            onSaveSemanticId={onSaveSemanticId}
            t={t}
          />
        )}
      </Fragment>

      <ElementActions
        node={node}
        busy={busy}
        {...(props.onAddChild ? { onAddChild: props.onAddChild } : {})}
        {...(props.onDuplicate ? { onDuplicate: props.onDuplicate } : {})}
        {...(props.onDelete ? { onDelete: props.onDelete } : {})}
        t={t}
      />
    </div>
  );
}
