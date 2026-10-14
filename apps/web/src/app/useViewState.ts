/**
 * View state — selected element · expansion · search · open forms and dialogs.
 * Split out of App.tsx (2026-10-13 componentization) — declarations and comments are verbatim from before the move.
 */
import { useRef, useState } from 'react';
import { type HistoryEntry } from '../api.js';
import { type Adder } from '../components/HierarchyTree.js';
import { type FixPlan } from '../components/FixPreview.js';
import { type Adding } from './types.js';

export function useViewState() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /**
   * The selection is held **as a position, not a node object**.
   * Every save re-reads from the server and rebuilds the tree, so holding the object
   * would leave stale values on screen.
   */
  const [selectedKey, setSelectedKey] = useState<string>();
  /** Search within the tree */
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState<string>();
  /** File list panel — see the accumulated files at a glance and remove them */
  const [filesOpen, setFilesOpen] = useState(false);
  /** Files checked in the file list — targets for bulk removal. Cleared when the list closes */
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string>>(new Set());
  /**
   * The file that submodel additions target — the current file by default. The ⚙ equipment context's "Add submodel to
   * this equipment" switches it to that equipment file (beginner request: it must be created right on the chosen equipment)
   */
  const [submodelTarget, setSubmodelTarget] = useState<
    { pid: string; assetName: string } | undefined
  >();
  /** Insertion point for "what is it made of" — also set by clicking a ▦ group in the tree */
  /** Input row open in the composition tree — it can also be opened by a ▦ click in the tree or "＋ …" in the summary, so it is held here */
  const [hierAdder, setHierAdder] = useState<Adder>();
  /** History panel — whose submodel history is being viewed */
  const [historyFor, setHistoryFor] = useState<{ submodelId: string; label: string } | undefined>();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  /** Open add form — 'submodel' or a parent node */
  const [adding, setAdding] = useState<Adding>();
  /** Rules/conventions view — shows the basis for verdicts */
  const [showRules, setShowRules] = useState(false);
  /**
   * Whether to show the findings list as a popup.
   * Important: removed from its permanent spot in the right pane — most of the time only "how many" matters,
   *    and the list is needed only when looked at. That spot is used by collection (OPC UA) (user request 2026-09-01).
   */
  const [showFindings, setShowFindings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** Account view — my password, plus adding people · roles · locking for admins */
  /** Account dialog — mine: my account settings (anyone) · people: account management (admin) */
  const [showAccounts, setShowAccounts] = useState<'mine' | 'people'>();
  /**
   * Auto-fix preview — a popup when open. Applies only the checked items (user 2026-09-11).
   * Important: **one group per file**. Opening a process (bundle) brings in the spliced equipment files too
   *    (2026-10-01). Fixes go to each source file — the same path as edits and submodel additions.
   */
  const [fixPlans, setFixPlans] = useState<FixPlan[] | undefined>();
  /** When the "Serving" chip is clicked — only here do we explain what the address means */
  const [showOpcua, setShowOpcua] = useState(false);
  /** MES / ERP / CMMS integration window (Settings → Integrations) — what it shows depends on the role */
  const [showIntegrations, setShowIntegrations] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  return { expanded, setExpanded, selectedKey, setSelectedKey, query, setQuery, reveal, setReveal, filesOpen, setFilesOpen, pickedFiles, setPickedFiles, submodelTarget, setSubmodelTarget, hierAdder, setHierAdder, historyFor, setHistoryFor, historyEntries, setHistoryEntries, adding, setAdding, showRules, setShowRules, showFindings, setShowFindings, showSettings, setShowSettings, showAccounts, setShowAccounts, fixPlans, setFixPlans, showOpcua, setShowOpcua, showIntegrations, setShowIntegrations, fileInput, bundleInput };
}
