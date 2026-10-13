/**
 * 가운데 칸 — 파일 목록 · 이력 · 입력 양식 · 요약과 구성 · 설비 정보 · 속성 편집.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업 · 클래스 이름 · 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름의 props 로 받는다.
 */
import { api, type HierarchyNode } from '../api.js';
import { AddAid } from '../components/AddAid.js';
import { AddElement, CONTAINER_TYPES } from '../components/AddElement.js';
import { AddSubmodel } from '../components/AddSubmodel.js';
import { NewPackage } from '../components/NewPackage.js';
import { DocAssets } from '../components/DocAssets.js';
import { BundlePanel } from '../components/BundlePanel.js';
import { ImportSubmodel } from '../components/ImportSubmodel.js';
import { Hierarchy } from '../components/Hierarchy.js';
import { Summary } from '../components/Summary.js';
import { DerivationCard } from '../components/derivation/DerivationCard.js';
import { Inspector } from '../components/Inspector.js';
import type { TreeNode } from '../model.js';
import { tr } from '../i18n.js';
import { FileListPanel } from './FileListPanel.js';
import { HistoryPanel } from './HistoryPanel.js';
import { AssetContext } from './AssetContext.js';
import { summaryComposition, summaryTotals } from './summaryCounts.js';
import type { Screen } from './context.js';

export function MiddlePane(props: Pick<Screen, 'adding' | 'allFindings' | 'busy' | 'conceptIds' | 'concepts' | 'deletePackages' | 'fileUnit' | 'filesOpen' | 'hierAdder' | 'hierarchy' | 'historyEntries' | 'historyFor' | 'leafNames' | 'ledger' | 'linked' | 'linkedConceptIds' | 'loadPackage' | 'onAddHierarchyGroup' | 'onAddHierarchyManual' | 'onAddHierarchyNode' | 'onAddHierarchySplit' | 'onBulkSaveValues' | 'onChangeValueType' | 'onCreateElement' | 'onCreatePackage' | 'onCreateSubmodel' | 'onDelete' | 'onDeleteAttachment' | 'onDownloadAttachment' | 'onDuplicate' | 'onImport' | 'onImportForTree' | 'onRemoveHierarchyNode' | 'onRename' | 'onRestore' | 'onRevertLedger' | 'onSave' | 'onSaveAssetInformation' | 'onSaveConcept' | 'onSaveSemanticId' | 'onShowHistory' | 'onUploadAttachment' | 'onUploadThumbnail' | 'opcua' | 'packageId' | 'packages' | 'pickedFiles' | 'policy' | 'selected' | 'selectedTrail' | 'setAdding' | 'setFilesOpen' | 'setHierAdder' | 'setHistoryFor' | 'setNotice' | 'setPickedFiles' | 'setSelectedKey' | 'setSubmodelTarget' | 'shell' | 'shells' | 'submodelTarget' | 'submodels' | 't' | 'requirements' | 'interfaces' | 'run' | 'revisions'>): React.JSX.Element {
  const { adding, allFindings, busy, conceptIds, concepts, deletePackages, fileUnit, filesOpen, hierAdder, hierarchy, historyEntries, historyFor, leafNames, ledger, linked, linkedConceptIds, loadPackage, onAddHierarchyGroup, onAddHierarchyManual, onAddHierarchyNode, onAddHierarchySplit, onBulkSaveValues, onChangeValueType, onCreateElement, onCreatePackage, onCreateSubmodel, onDelete, onDeleteAttachment, onDownloadAttachment, onDuplicate, onImport, onImportForTree, onRemoveHierarchyNode, onRename, onRestore, onRevertLedger, onSave, onSaveAssetInformation, onSaveConcept, onSaveSemanticId, onShowHistory, onUploadAttachment, onUploadThumbnail, opcua, packageId, packages, pickedFiles, policy, selected, selectedTrail, setAdding, setFilesOpen, setHierAdder, setHistoryFor, setNotice, setPickedFiles, setSelectedKey, setSubmodelTarget, shell, shells, submodelTarget, submodels, t, requirements, interfaces, run, revisions } = props;
  /**
   * 구성 패널 — 공정 파일에서는 **요약 머리 바로 밑**에 온다(사용자 2026-09-08: "공정 만들고 하위에 설비
   * 등록하려면 안 되는데" — 폼이 타일·판정 아래 화면 밖에 있어 보이지 않았다). 공정 파일의 정체는 구성이다.
   * 설비 파일에서는 부품 구성이 부차적이라 예전처럼 요약 뒤에 둔다.
   */
  const hierarchyPanel =
    hierarchy?.entryNode && packageId ? (
            <Hierarchy
              t={t}
              key={packageId} // 파일을 바꾸면 열려 있던 넣기 폼도 접힌다(실측: 이전 파일의 폼이 따라왔다)
              view={hierarchy}
              unit={fileUnit}
              {...(hierAdder ? { adder: hierAdder } : {})}
              onAdderChange={setHierAdder}
              {...(policy ? { iriBase: policy.iriBase } : {})}
              candidates={packages.filter((item) => item.packageId !== packageId)}
              onImportFile={onImportForTree}
              busy={busy}
              onAdd={(source, count, parent) => void onAddHierarchyNode(source, count, parent)}
              onAddSplit={(source, count, parent) =>
                void onAddHierarchySplit(source, count, parent)
              }
              onAddManual={(name, assetId, bulk, parent) =>
                void onAddHierarchyManual(name, assetId, bulk, parent)
              }
              onAddGroup={(name, parent, line) => void onAddHierarchyGroup(name, parent, line)}
              onRemove={(name, parent) => void onRemoveHierarchyNode(name, parent)}
              // ㉯ 자식 설비의 서브모델을 그 자리에서 읽어 온다 — 파일 구조는 그대로다
              fetchSubmodels={async (id) => (await api.submodels(id)).result}
              onOpen={(id) => void loadPackage(id)}
            />
    ) : undefined;
  return (
    <div className="middle">
      {filesOpen && (
        <FileListPanel
          packages={packages}
          {...(packageId ? { packageId } : {})}
          picked={pickedFiles}
          busy={busy}
          onPick={setPickedFiles}
          onOpen={(id) => void loadPackage(id)}
          onDelete={(ids) => void deletePackages(ids)}
          onClose={() => setFilesOpen(false)}
        />
      )}
      {historyFor && (
        <HistoryPanel
          t={t}
          label={historyFor.label}
          entries={historyEntries}
          busy={busy}
          onRestore={(changedAt) => void onRestore(changedAt)}
          onClose={() => setHistoryFor(undefined)}
        />
      )}
      {adding === 'aid' && packageId && (
        <AddAid
          packageId={packageId}
          leafNames={leafNames}
          busy={busy}
          {...(opcua?.running && opcua.endpoint ? { outEndpoint: opcua.endpoint } : {})}
          onCancel={() => setAdding(undefined)}
          onDone={(summary) => {
            setAdding(undefined);
            setNotice(summary);
            if (packageId) void loadPackage(packageId);
          }}
        />
      )}
      {adding === 'docs' && packageId && (
        <DocAssets
          packageId={packageId}
          submodels={submodels}
          assetName={shell?.idShort ?? tr('설비')}
          onClose={() => setAdding(undefined)}
        />
      )}
      {adding === 'bundle' && packageId && (
        <BundlePanel
          packageId={packageId}
          onOpenPackage={(id) => {
            setAdding(undefined);
            void loadPackage(id);
          }}
          onClose={() => setAdding(undefined)}
        />
      )}
      {adding === 'new' && (
        <NewPackage
          t={t}
          {...(policy ? { policy } : {})}
          busy={busy}
          onCancel={() => setAdding(undefined)}
          candidates={packages}
          onImportFile={onImportForTree}
          onCreate={(name, extras, unit, tree) => void onCreatePackage(name, extras, unit, tree)}
        />
      )}
      {adding === 'submodel' && (
        <AddSubmodel
          {...(policy ? { policy } : {})}
          assetName={submodelTarget?.assetName ?? shell?.idShort ?? 'Asset'}
          existing={submodels.map((sm) => sm.idShort ?? '')}
          busy={busy}
          onCancel={() => setAdding(undefined)}
          onCreate={(content) => void onCreateSubmodel(content)}
        />
      )}
      {adding === 'import' && packageId && (
        <ImportSubmodel
          packages={packages}
          currentPackageId={packageId}
          existing={submodels}
          busy={busy}
          onCancel={() => setAdding(undefined)}
          onImport={(source, submodelId, onDuplicate) => void onImport(source, submodelId, onDuplicate)}
        />
      )}
      {adding && adding !== 'submodel' && adding !== 'import' && adding !== 'new' && adding !== 'docs' && adding !== 'aid' && adding !== 'bundle' && (
        <AddElement
          parentLabel={adding.label}
          busy={busy}
          onCancel={() => setAdding(undefined)}
          onCreate={(content) => void onCreateElement(adding, content)}
        />
      )}
      {!selected && !adding && packageId && (
        <Summary
          t={t}
          fileName={packages.find((item) => item.packageId === packageId)?.name ?? packageId}
          unit={fileUnit}
          onAddSubmodel={() => setAdding('submodel')}
          onAddAsset={() => setHierAdder({ path: [], kind: 'asset' })}
          onAddGroup={() => setHierAdder({ path: [], kind: 'group' })}
          derivation={<DerivationCard packageId={packageId} packages={packages} busy={busy} run={run} loadPackage={loadPackage} setNotice={setNotice} revisions={revisions} />}
          ledgerCount={Object.keys(ledger).length}
          onRevertLedger={() => void onRevertLedger()}
          thumbnailPlaceholder={
            (shells[0]?.assetInformation?.['defaultThumbnail'] as { path?: string } | undefined)
              ?.path === '/thumbnail.png'
          }
          {...(String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/') &&
          hierarchy?.entryNode
            ? {
                totals: summaryTotals(submodels, concepts, linked),
                composition: summaryComposition(hierarchy),
              }
            : {})}
          shells={shells}
          submodels={submodels}
          concepts={concepts}
          findings={allFindings}
          {...(policy &&
          // 🔴 조직 단위(공정·회사 — assetType=…/type/*)에는 설비 필수 4종 안내를 하지
          //    않는다 — 계층만으로 시작하는 것이 맞다(2026-08-26 확정)
          !String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/')
            ? { requiredSubmodels: policy.requiredSubmodels }
            : {})}
        >
          {fileUnit === 'composite' ? hierarchyPanel : undefined}
        </Summary>
      )}
      {!selected && !adding && packageId && fileUnit === 'equipment' && hierarchyPanel}
      {/* ⚙ 설비 컨텍스트 — 고른 장비에 맞는 동작이 그 자리에 나온다(초보자 원칙) */}
      {selected && selected.modelType === 'LinkedAsset' && selected.linkedPackageId && (
        <AssetContext
          label={selected.label}
          fileName={packages.find((item) => item.packageId === selected.linkedPackageId)?.name ?? selected.linkedPackageId}
          busy={busy}
          onAddSubmodel={() => {
            // 이 설비 파일에 만들어진다 — onCreateSubmodel이 대상을 보고 라우팅한다
            setSubmodelTarget({ pid: selected.linkedPackageId!, assetName: selected.node.idShort ?? selected.label });
            setAdding('submodel');
            setSelectedKey(undefined);
          }}
          onOpenFile={() => void loadPackage(selected.linkedPackageId!)}
          onClose={() => setSelectedKey(undefined)}
        />
      )}
      {selected && selected.modelType !== 'LinkedAsset' && (
      <Inspector
        t={t}
        {...(selected ? { node: selected, trail: selectedTrail } : {})}
        {...(selected?.linkedPackageId !== undefined
          ? {
              linkedFileName:
                packages.find((item) => item.packageId === selected.linkedPackageId)?.name ??
                selected.linkedPackageId,
            }
          : {})}
        // 값 표의 「구분」 — 이 파일의 서브모델일 때만(이어 붙인 설비 파일의 템플릿·수집 연결은 그 파일을 열어 본다)
        {...(selected && selected.linkedPackageId === undefined && requirements[selected.submodelId]
          ? { requirement: requirements[selected.submodelId]! }
          : {})}
        {...(selected && selected.linkedPackageId === undefined
          ? { collectedNames: new Set(interfaces.flatMap((item) => item.properties.map((property) => property.name))) }
          : {})}
        onClose={() => setSelectedKey(undefined)}
        onChangeValueType={(node, valueType) => void onChangeValueType(node, valueType)}
        onShowHistory={(node) => void onShowHistory(node)}
        onBulkSaveValues={(node, content) => void onBulkSaveValues(node, content)}
        onCsvFilled={(notice) => {
          setNotice(notice);
          if (packageId) void loadPackage(packageId);
        }}
        busy={busy}
        onSave={(node, value) => void onSave(node, value)}
        {...(selected && CONTAINER_TYPES.has(selected.modelType)
          ? { onAddChild: (node: TreeNode) => setAdding(node) }
          : {})}
        {...(selected && (selected.modelType === 'Submodel' || selected.idShortPath !== undefined)
          ? { onDelete: (node: TreeNode) => void onDelete(node) }
          : {})}
        {...(selected &&
        selected.idShortPath !== undefined &&
        selected.linkedPackageId === undefined &&
        CONTAINER_TYPES.has(selected.modelType)
          ? { onDuplicate: (node: TreeNode) => void onDuplicate(node) }
          : {})}
        {...(policy ? { policy } : {})}
        conceptIds={
          selected?.linkedPackageId !== undefined
            ? (linkedConceptIds.get(selected.linkedPackageId) ?? conceptIds)
            : conceptIds
        }
        onSaveSemanticId={(node, value) => void onSaveSemanticId(node, value)}
        onSaveAssetInformation={(info) => void onSaveAssetInformation(info)}
        onSaveConcept={(concept) => void onSaveConcept(concept)}
        onUploadThumbnail={(file) => void onUploadThumbnail(file)}
        onRename={(node, value) => void onRename(node, value)}
        onUploadAttachment={(node, file) => void onUploadAttachment(node, file)}
        onDownloadAttachment={(node, name) => void onDownloadAttachment(node, name)}
        onDeleteAttachment={(node) => void onDeleteAttachment(node)}
      />
      )}
    </div>
  );
}
