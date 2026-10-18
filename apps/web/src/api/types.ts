/**
 * API client — shapes (types) the server exchanges.
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { Finding } from '../model.js';

export interface PackageDescription {
  packageId: string;
  aasIds: string[];
  name?: string;
  /** The AAS idShort — the filename alone does not tell which asset it is */
  assetName?: string;
  globalAssetId?: string;
  /** …/type/* for a process (bundle) file */
  assetType?: string;
  revision?: number;
  updatedAt?: string;
  warnings?: string[];
}

/** Process hierarchy — what it is made of */
/** One line of change history — carries the full content as of that time */
export interface UndoStatus {
  /** Undoable changes — most recent first */
  undo: string[];
  redo: string[];
}

export interface HistoryEntry {
  changedAt: string;
  operation: 'update' | 'delete';
  revision: number;
  /** Summary for people to skim — element count at that time */
  elementCount: number;
  /**
   * Who changed it. **May be absent** — the server does not use login, or
   * the history predates the audit log (2026-10-02).
   */
  actorName?: string;
}

/** One hierarchy node — nested. Groups (intermediate nodes) have an empty globalAssetId */
export interface HierarchyNode {
  name: string;
  globalAssetId: string;
  bulkCount: number;
  /** Line level (company → line → process → asset). Older servers do not send it */
  line?: boolean;
  children: HierarchyNode[];
}

/** Hierarchy — company > process > equipment can live in a single file */
export interface HierarchyView {
  entryNode: { name: string; globalAssetId: string } | null;
  children: HierarchyNode[];
}

export interface LintReport {
  passed: boolean;
  countBySeverity: { error: number; warning: number; info: number };
  countByRule: Record<string, number>;
  rulesRun: number;
  findings: Finding[];
}

/** Interface described by AID (M8) */
export interface AidInterfaceView {
  name: string;
  title?: string;
  protocol: string;
  base?: string;
  /** What the AID states (2.8.0 makes it from the screen) — `UserName` also stands for an MQTT login */
  security?: { mode?: 'None' | 'Sign' | 'SignAndEncrypt'; policy?: string; userIdentityToken?: string };
  properties: {
    name: string;
    key?: string;
    type?: string;
    unit?: string;
    href?: string;
    observable: boolean;
    /** Protocol form fields (modv_* · mqv_* · read period) — "Edit link" starts from them */
    formFields?: Record<string, string>;
  }[];
}

/** The security a person chooses for a collection link (2.8.0) */
export interface AidSecurityChoice {
  mode?: 'None' | 'Sign' | 'SignAndEncrypt';
  policy?: string;
  /** The device wants a user name and password — they stay in the credentials files, never in the AAS */
  login?: boolean;
}

export interface CollectedValueView {
  interfaceName: string;
  propertyName: string;
  source?: string;
  observedAt: string;
  /** When this tool actually read it — the basis for freshness (receiving · disconnected). Absent in old records (they used observedAt) */
  receivedAt?: string;
  valueNumber?: number;
  valueText?: string;
  quality?: string;
  /** Why the read failed (2.8.0) — then there is no value. Stored by the remote collector and automatic collection */
  error?: string;
}

export interface LiveMapping {
  collected: number;
  applied: number;
  notes: { propertyName: string; outcome: 'applied' | 'ambiguous' | 'unmatched'; paths: string[] }[];
}

export interface CycleReportView {
  startedAt: string;
  collected: number;
  interfaces: {
    name: string;
    error?: string;
    report?: {
      failures: { propertyName: string; reason: string }[];
      /**
       * Important: **no value has arrived yet** — distinct from failure. The output is a Type, so empty values are normal,
       *    and devices give no values before initialization. Counting this as failure shows "60 bad tags" and
       *    people think the device is broken. When empty the server omits it entirely (still compatible with old servers).
       */
      pending?: { propertyName: string; reason: string }[];
    };
  }[];
}

export interface FixReport {
  applied: { ruleId: string; pointer: string; key?: string; elementType?: string; description: string; before?: unknown; after?: unknown }[];
  skipped: { ruleId: string; pointer: string; reason: string }[];
  /** IRIs moved in this correction (new → original) */
  relocations: Record<string, string>;
  /** The whole migration ledger stored in the file — only returned on apply (POST) */
  ledger?: Record<string, string>;
  rounds: number;
  before: LintReport;
  after: LintReport;
}

/** Linter policy — used when generating new ids. Conventions live only on the server (linter) */
export interface Policy {
  iriBase: string;
  irdiPrefixes: string[];
  requiredSubmodels: string[];
}

/** Login state — the first thing the UI asks */
export interface AuthState {
  authenticated: boolean;
  /** No accounts at all — the first admin must be created */
  setupNeeded: boolean;
  /** Does this server require login (or an API key)? When off, the login screen is not shown */
  authRequired: boolean;
  /**
   * Whether creating the first admin must ask for the **setup code** — true only on servers exposed to the outside.
   * Prevents whoever comes first from becoming admin (the code is written in the server startup log).
   */
  setupCodeRequired?: boolean;
  /** Whether users can self-register — decides if the login screen shows "Sign up" */
  signupAllowed?: boolean;
  /**
   * Privacy policy URL. **When absent the server does not accept contact details** —
   * and the UI hides the contact field too (if we cannot state how it is used, we do not collect it).
   */
  privacyUrl?: string;
  /**
   * Trial mode? When true the UI shows a banner and **hides the download buttons** —
   * saying "sign up and you can" up front beats letting people click and see a 403.
   */
  demo?: { login: string; password: string };
  user?: { id: string; login: string; displayName: string; role: 'admin' | 'editor' | 'viewer'; level: 'full' | 'read-only'; email?: string; company?: string };
}

/** One row in the account management screen */
export interface UserView {
  id: string;
  login: string;
  displayName: string;
  role: 'admin' | 'editor' | 'viewer';
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
  /** What was collected at sign-up — sent only to admins */
  email?: string;
  company?: string;
  consentAt?: string;
  /** Trial account (public server) — cannot be deleted or locked */
  demo?: boolean;
}

/**
 * Template requirement level — "required · optional" for each element of one submodel (2026-10-13).
 * Keys are element paths (list children as `[]`). Submodels without a template are omitted entirely — the UI shows them as "unknown".
 */
export interface SubmodelRequirement {
  submodelId: string;
  semanticId: string;
  template?: string;
  templateFile?: string;
  elements: Record<string, { cardinality: 'One' | 'ZeroToOne' | 'ZeroToMany' | 'OneToMany'; required: boolean }>;
}

export * from './bundleDocTypes.js';

/** Type → unit derivation — one row for a place the type file changed (same shape as server packages/linter/src/derivation.ts) */
export interface DerivationChange {
  key: string;
  submodel: string;
  path: string;
  kind: 'changed' | 'added' | 'removed';
  action: 'apply' | 'skip' | 'same';
  reason?: 'edited-here' | 'parent-missing' | 'submodel-missing';
  base?: string;
  theirs?: string;
  mine?: string;
}

export interface DerivationView {
  linked: boolean;
  sourcePackageId?: string;
  sourceName?: string;
  appliedAt?: string;
  sourceMissing?: boolean;
  changes?: DerivationChange[];
  counts?: { apply: number; skip: number };
}
