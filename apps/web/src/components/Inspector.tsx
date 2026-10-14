/**
 * Property editing.
 *
 * Value changes go out only one way: the Part 2 `$value` PATCH.
 * Under option A (the file is the source of truth) an edit here is an edit that stays in the file — so it does not
 * become an irreversible mistake, only screen state changes until save, and the saved result is re-read from the server to confirm.
 *
 * 2026-10-13 componentization — each editor was split into a part under inspector/. This file only decides what to show.
 */
import { Fragment, useMemo } from 'react';
import type { Policy, SubmodelRequirement } from '../api.js';
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
   * Clear the selection — close the editor and return to the summary / "What is it made of" / collection screen.
   * Important: without this, once you picked a tree node there was **no way back** to the add-equipment screen (measured).
   */
  onClose?: () => void;
  /** Path to this element (ancestor names) — the title alone does not show "where this element belongs" */
  trail?: readonly string[];
  busy: boolean;
  onSave: (node: TreeNode, value: unknown) => void;
  /** Given when elements can be created under this node */
  onAddChild?: (node: TreeNode) => void;
  /** Rename (idShort). Not given for list children */
  onRename?: (node: TreeNode, name: string) => void;
  /** Attach an actual file to a File / Blob element (manual PDF, drawing) */
  onUploadAttachment?: (node: TreeNode, file: File) => void;
  onDownloadAttachment?: (node: TreeNode, filename: string) => void;
  onDeleteAttachment?: (node: TreeNode) => void;
  onDelete?: (node: TreeNode) => void;
  /** Copy right below — for filling the same structure several times */
  onDuplicate?: (node: TreeNode) => void;
  /** Fix attributes that $value cannot change, such as valueType — replaces the whole element */
  onChangeValueType?: (node: TreeNode, valueType: string) => void;
  /** Open the submodel change history — the way to undo mistakes */
  onShowHistory?: (node: TreeNode) => void;
  /**
   * Save values in bulk — picking a submodel lets you enter its values (Property · MLP · Range) as a table.
   * Clicking elements one by one and saving 40 times is not a job for a person (follow-up proposal from the beginner journey).
   * Saves with a single PATCH — writing per row puts the revision out of step and every write after the first gets 409.
   */
  onBulkSaveValues?: (node: TreeNode, content: Record<string, unknown>) => void;
  /** After fill-from-CSV finishes (the value table opens) */
  onCsvFilled?: (notice: string) => void;
  /** If this element belongs to another file, that file's name — the user must know what they are editing */
  linkedFileName?: string;
  /** Used for the semanticId check (reduced M4) */
  policy?: Policy;
  conceptIds?: ReadonlySet<string>;
  onSaveSemanticId?: (node: TreeNode, semanticId: string) => void;
  /** Save AssetInformation — assetKind · globalAssetId */
  onSaveAssetInformation?: (info: Record<string, unknown>) => void;
  /** Save a concept (CD) definition — passes the whole replaced CD */
  onSaveConcept?: (concept: Record<string, unknown>) => void;
  /**
   * Upload the main photo — where the skeleton's placeholder image is replaced with a real equipment photo.
   * Important: the guidance text kept saying "you can change it in AssetInformation", yet there was no upload
   *    button (measured in the beginner journey, 2026-08-26). The server API had been there from the start.
   */
  onUploadThumbnail?: (file: File) => void;
  /** Template requirement level of the submodel this element belongs to — the value table's "Kind" (required · optional). Absent = unknown */
  requirement?: SubmodelRequirement;
  /** Collection-connection (AID) item names of this file — shown as "Collected" in the value table */
  collectedNames?: ReadonlySet<string>;
  /** Translator — returns the Korean as is when the dictionary has no entry (i18n.ts) */
  t: (text: string) => string;
}

export function Inspector(props: Props): React.JSX.Element {
  const { node, busy, t } = props;
  /**
   * **Fingerprint** of "what is being viewed right now".
   *
   * Important: input reset used to be keyed on `[node]` (object identity), so merely **rebuilding** the tree
   *    wiped the value being typed. The tree is rebuilt whole when any one of `shells·submodels·concepts·hierarchy·linked`
   *    changes, and those arrive **in several pieces** when a file opens.
   *    If a person is typing in between, the input is lost — this was the test that failed intermittently
   *    under load (root cause found 2026-10-02).
   *
   * So reset happens **only when the content really changed**. Save, undo and history restore change the
   * content and still reset; a tree that was merely rebuilt is left alone.
   * The fingerprint is computed only when the objects change — serializing on every render would be its own waste.
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

      {/* When the content changes (another element · re-read after save), redraw the editors so inputs start from the initial value — see the fingerprint note above */}
      <Fragment key={signature}>
        {editable && <ValueEditor node={node} busy={busy} onSave={onSave} t={t} />}

        {/* AssetInformation has edit fields below, so it must not say "not editable" */}
        {!editable && node.modelType !== 'ConceptDescriptionGroup' && node.modelType !== 'AssetInformation' && (
          <ElementHint node={node} />
        )}

        {node.modelType === 'Submodel' && onBulkSaveValues && (
          <BulkValues
            node={node}
            busy={busy}
            {...(props.requirement ? { requirement: props.requirement } : {})}
            {...(props.collectedNames ? { collectedNames: props.collectedNames } : {})}
            onBulkSaveValues={onBulkSaveValues}
            {...(props.onCsvFilled ? { onCsvFilled: props.onCsvFilled } : {})}
            t={t}
          />
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
          Rename (idShort).
          Important: list (SubmodelElementList) children are excluded — they are addressed by position,
          and giving them a name violates a spec constraint (AASd-120). A path ending in `[n]` is a list child.
        */}
        {onRename && renameable(node) && <RenameEditor node={node} busy={busy} onRename={onRename} t={t} />}

        {/*
          Attachment — the actual file a File / Blob points to.
          The manual PDF in HandoverDocumentation is the substance of the deliverable, so fixing only the value (path) is not enough —
          **the file itself must be uploadable**.
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
