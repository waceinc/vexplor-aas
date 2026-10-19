/**
 * Middle pane — file list · history · input forms · summary and composition · equipment info · property editing.
 * Split out of App.tsx (componentization, 2026-10-13) — markup, class names and comments are verbatim from before the move,
 * and the state and actions it uses arrive as props with the same names.
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
  // The metamodel version of the file the selected element is in — a linked equipment file has its own
  const inspectedMetamodel = selected
    ? packages.find((item) => item.packageId === (selected.linkedPackageId ?? packageId))?.metamodel?.version
    : undefined;
  /**
   * Composition panel — in a process file it comes **right below the summary header** (user, 2026-09-08: "I made a process but can't
   * register equipment under it" — the form sat below the tiles and verdict, off-screen). A process file is defined by its composition.
   * In an equipment file the part composition is secondary, so it stays after the summary as before.
   */
  const hierarchyPanel =
    hierarchy?.entryNode && packageId ? (
            <Hierarchy
              t={t}
              key={packageId} // Switching files also collapses an open add form (observed: the previous file's form carried over)
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
              // (b) Read the child equipment's submodels in place — the file structure is unchanged
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
          // Important: organizational units (process, company — assetType=…/type/*) do not get the four-required-equipment-submodels
          //    hint — starting with the hierarchy alone is correct (confirmed 2026-08-26)
          !String(shells[0]?.assetInformation?.['assetType'] ?? '').includes('/type/')
            ? { requiredSubmodels: policy.requiredSubmodels }
            : {})}
        >
          {fileUnit === 'composite' ? hierarchyPanel : undefined}
        </Summary>
      )}
      {!selected && !adding && packageId && fileUnit === 'equipment' && hierarchyPanel}
      {/* Equipment context — actions matching the selected equipment appear in place (beginner principle) */}
      {selected && selected.modelType === 'LinkedAsset' && selected.linkedPackageId && (
        <AssetContext
          label={selected.label}
          fileName={packages.find((item) => item.packageId === selected.linkedPackageId)?.name ?? selected.linkedPackageId}
          busy={busy}
          onAddSubmodel={() => {
            // Created in this equipment file — onCreateSubmodel routes by target
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
        {...(inspectedMetamodel ? { metamodel: inspectedMetamodel } : {})}
        {...(selected?.linkedPackageId !== undefined
          ? {
              linkedFileName:
                packages.find((item) => item.packageId === selected.linkedPackageId)?.name ??
                selected.linkedPackageId,
            }
          : {})}
        // The "Category" column of the value table — only for this file's own submodels (for a linked equipment file's template and collection links, open that file)
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
