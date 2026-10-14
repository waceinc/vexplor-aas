/**
 * API client — shapes (types) of reference bundles · document data · rule lists.
 * Split out of src/api.ts (2026-10-13 componentization). Re-exported by api/types.ts.
 */

/** Reference bundle — readiness of one asset bound to a process */
export interface BundleMemberView {
  name: string;
  globalAssetId: string;
  bulkCount: number;
  groupPath: string[];
  packageId?: string;
  fileName?: string;
  version?: string;
  /** aasd120 — number of AASd-120 cases the standard validator (aas-test-engines) treats as errors. KOSMO does not check them */
  lint?: { passed: boolean; error: number; warning: number; aasd120?: number };
  /** Demo copy with a collection connection (AID) attached */
  demo?: { login: string; password: string };
}

export interface LinkPointView {
  member: string;
  path: string;
  idShort: string;
  semanticId: string;
  valueType?: string;
  unit?: string;
}

export interface LinkageItemView {
  semanticId: string;
  label: string;
  names: string[];
  preferredName?: string;
  unit?: string;
  points: Record<string, LinkPointView[]>;
  coverage: number;
}

export interface LinkageFindingView {
  kind: 'shared-semantic' | 'split-semantic';
  severity: 'warning' | 'info';
  message: string;
  semanticIds: string[];
  names: string[];
}

/** Runtime evidence — summary of collection records of the asset (type) itself or of units derived from it */
export interface EvidenceSourceView {
  model: string;
  instance: string;
  direct: boolean;
  interfaces: { title: string; endpoint: string; simulated: boolean }[];
  from: string;
  to: string;
  samples: number;
  properties: number;
  truncated?: boolean;
}

export type EvidenceLevel = 'A' | 'B' | 'C';

export interface BundleView {
  process: { name: string; fileName: string };
  categories: Record<string, string>;
  members: BundleMemberView[];
  linkage: { members: string[]; missing: string[]; items: LinkageItemView[]; findings: LinkageFindingView[] };
  evidence: {
    suggested: EvidenceLevel | null;
    levels: Record<EvidenceLevel, string>;
    sources: EvidenceSourceView[];
    /** Earlier evidence carried over when the bundle was opened — included when there is no new collection */
    carried?: {
      level: string | null;
      entries: EvidenceSourceView[];
      from: { code?: string; version?: string; createdAt?: string };
    };
  };
  /** Documents · evidence added by people — preserved across re-exports */
  attachments: { path: string; size: number }[];
  attachmentFolders: string[];
}

export interface BundleImportView {
  bundle: { code?: string; title?: string; version?: string };
  processPackageId?: string;
  files: { file: string; packageId: string; hashOk: boolean | null; reused: boolean }[];
  problems: string[];
}

/** Rule · convention catalog — material showing the basis of each verdict */
export interface RuleCatalog {
  rules: { id: string; layer: string; title: string; source: string; fixable: boolean }[];
  layers: { layer: string; title: string; meaning: string; count: number }[];
  conflicts: {
    key: string;
    title: string;
    conflict: string;
    choices: { value: string; meaning: string }[];
    current: string;
  }[];
  conventions: { key: string; title: string; value: string; source: string }[];
  verdict: { who: string; role: string }[];
  sources: { key: string; from: string }[];
}

/** Per-submodel document data plan (regulation §13 caution 5) */
export interface DocPlan {
  idShort: string;
  kind: 'table' | 'info';
  reason: string;
}

export interface TableRow {
  depth: number;
  path: string;
  idShort: string;
  modelType: string;
  dataType: string;
  unit: string;
  example: string;
  semanticId: string;
  description: string;
}

/** The IDTA SMT table the actual guidance uses (regulation §13 caution 5) */
export interface SemanticCell {
  idType: string;
  id: string;
  definition: string;
  korean: string;
  idtaOrigin: string;
}

export interface SmtChildRow {
  label: string;
  semantic: SemanticCell;
  value: string;
  cardinality: string;
}

export interface SmtTable {
  idShort: string;
  className: string;
  semantic: SemanticCell;
  parent: string;
  explanation: string;
  children: SmtChildRow[];
}

export interface SubmodelInfo {
  idShort: string;
  externalTemplate: string;
  dictionaries: string[];
  templateLink: string;
  elementCount: number;
  toWrite: string[];
}
