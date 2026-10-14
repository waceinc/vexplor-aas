/**
 * Contents of the open file — data read from the server (submodels · findings · hierarchy · collected values · version number · undo stack · linked files).
 * Split out of App.tsx (2026-10-13 componentization) — declarations and comments are verbatim from before the move.
 */
import { useMemo, useRef, useState } from 'react';
import { api, type AidInterfaceView, type HierarchyView, type UndoStatus, type CycleReportView, type LiveMapping, type CollectedValueView, type FixReport, type PackageDescription, type Policy, type SubmodelRequirement } from '../api.js';
import { type LinkedInfo, type Finding, type ConceptDescription, type Shell, type Submodel } from '../model.js';

export function useDocumentState() {
  const [packages, setPackages] = useState<PackageDescription[]>([]);
  const [packageId, setPackageId] = useState<string>();
  const [submodels, setSubmodels] = useState<Submodel[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [fixReport, setFixReport] = useState<FixReport>();
  const [policy, setPolicy] = useState<Policy>();
  const [shells, setShells] = useState<Shell[]>([]);
  const [concepts, setConcepts] = useState<ConceptDescription[]>([]);
  const shell = shells[0];
  const conceptIds = useMemo(() => new Set(concepts.map((cd) => cd.id)), [concepts]);
  /** Submodel id → revision. Sent back as If-Match when editing */
  const [interfaces, setInterfaces] = useState<AidInterfaceView[]>([]);
  // The process hierarchy — equipment files also have a component hierarchy, read in the same place
  const [hierarchy, setHierarchy] = useState<HierarchyView | undefined>(undefined);
  /** Child branches spliced into the tree (recursive) — company → process → equipment */
  const [linked, setLinked] = useState<LinkedInfo[]>([]);
  /**
   * The CD check for an equipment element picked in the process view uses **that equipment file's CD**.
   * Important: checking against the process file falsely raised "CD not in file" for SPR's compound IRDI
   *    (0173-1#02-ABI500#003/0173-1#01-AHF579#003) — the CD is in the SPR file (user, 2026-09-30)
   */
  const linkedConceptIds = useMemo(() => {
    const byPackage = new Map<string, ReadonlySet<string>>();
    const walk = (nodes: LinkedInfo[]): void => {
      for (const node of nodes) {
        if (node.packageId && node.concepts) byPackage.set(node.packageId, new Set(node.concepts.map((cd) => cd.id)));
        walk(node.children);
      }
    };
    walk(linked);
    return byPackage;
  }, [linked]);
  /** Submodel revisions of linked files — used for conflict protection when **editing a ⚙ branch directly** */
  const [linkedRevisions, setLinkedRevisions] = useState<Record<string, Record<string, number>>>({});
  /**
   * Findings of linked files — shown merged in the right panel.
   * Important: edits under ⚙ are saved to that file, and if its findings were hidden it would be half-done:
   *    "edited but not checked" (user report 2026-08-26). packageId → that file's findings
   */
  const [linkedFindings, setLinkedFindings] = useState<Record<string, Finding[]>>({});
  const [values, setValues] = useState<CollectedValueView[]>([]);
  /** Whether collected values match model element names — the verdict on whether they can be exported via the standard API */
  const [live, setLive] = useState<LiveMapping>();
  /** Automatic collection status — whether the server has periodic collection on */
  const [autoCollect, setAutoCollect] = useState<Awaited<ReturnType<typeof api.collectStatus>>>();
  /** Whether we serve over OPC UA (M6·M7). Off by default in deployments, so may be absent */
  const [opcua, setOpcua] = useState<Awaited<ReturnType<typeof api.opcuaStatus>>>();
  /** Version number reported by the server — a mismatch between screen and server also signals a reload is needed */
  const [version, setVersion] = useState<string>();
  /** Result of the last collection cycle — the basis of the connection status icon */
  const [lastCycle, setLastCycle] = useState<CycleReportView>();
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  /** Undo stack — the server holds it; the screen only sees labels */
  const [undoState, setUndoState] = useState<UndoStatus>({ undo: [], redo: [] });
  const [shellRevisions, setShellRevisions] = useState<Record<string, number>>({});
  /** IRI migration ledger (new → original) — a part inside the file. Empty means nothing shows in the summary */
  const [ledger, setLedger] = useState<Record<string, string>>({});
  /** Template requirement levels — submodel id → required · optional per element. Submodels without a template are absent (unknown) */
  const [requirements, setRequirements] = useState<Record<string, SubmodelRequirement>>({});
  /**
   * Number of findings the preview said it "cannot fix" — keeps the button count and the popup in agreement.
   * Important: trusting only the rule's fixable flag made the button say "2" while the popup said "needs a human" (user, 2026-09-11).
   *    On opening a file, run a no-save preview once and turn fixable off for findings that really cannot be fixed
   */
  const [unfixable, setUnfixable] = useState(0);
  /** Count the preview said it would actually fix — the button's number. Includes findings revealed in later passes after fixing one (equals the popup's row count) */
  const [fixCount, setFixCount] = useState<number | undefined>();
  /** The last opened file. Used to keep the expansion state when the same file is re-read */
  const openedRef = useRef<string>(undefined);
  return { packages, setPackages, packageId, setPackageId, submodels, setSubmodels, findings, setFindings, fixReport, setFixReport, policy, setPolicy, shells, setShells, concepts, setConcepts, shell, conceptIds, interfaces, setInterfaces, hierarchy, setHierarchy, linked, setLinked, linkedConceptIds, linkedRevisions, setLinkedRevisions, linkedFindings, setLinkedFindings, values, setValues, live, setLive, autoCollect, setAutoCollect, opcua, setOpcua, version, setVersion, lastCycle, setLastCycle, revisions, setRevisions, undoState, setUndoState, shellRevisions, setShellRevisions, ledger, setLedger, requirements, setRequirements, unfixable, setUnfixable, fixCount, setFixCount, openedRef };
}
