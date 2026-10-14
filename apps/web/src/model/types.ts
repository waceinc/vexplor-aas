/**
 * Model — shapes and display of AAS nodes and UI tree.
 * Split out of src/model.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via model.ts.
 */


export interface Finding {
  ruleId: string;
  layer: string;
  severity: 'error' | 'warning' | 'info';
  elementType: string;
  key: string;
  pointer: string;
  kosmoPath: string;
  message: string;
  remedy?: string;
  fixable: boolean;
  policyNote?: string;
}

export interface AasNode {
  modelType: string;
  idShort?: string;
  value?: unknown;
  statements?: AasNode[];
  annotations?: AasNode[];
  valueType?: string;
  [key: string]: unknown;
}

export interface Submodel extends AasNode {
  id: string;
  submodelElements?: AasNode[];
}

export interface Shell extends AasNode {
  id: string;
  assetInformation?: Record<string, unknown>;
}

export interface ConceptDescription extends AasNode {
  id: string;
}

export interface Environment {
  shells: readonly Shell[];
  submodels: readonly Submodel[];
  conceptDescriptions: readonly ConceptDescription[];
}

/**
 * ISO time → `YYYY-MM-DD HH:mm:ss` in this PC's time zone.
 * Important: the collection table · address list CSV · history were printing UTC as is ("01:35" at 10:35 Seoul — measured 2026-09-10).
 *    The validation report was fixed to local time on 2026-09-04, but the UI side was left behind
 */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface TreeNode {
  /** React key and the identifier of expansion state */
  key: string;
  label: string;
  modelType: string;
  /** Environment JSON Pointer — matched against the linter finding */
  pointer: string;
  /** Part 2 idShortPath. undefined for the Submodel itself */
  idShortPath?: string;
  submodelId: string;
  depth: number;
  children: TreeNode[];
  node: AasNode;
  /**
   * Is this a **read-only** branch read from another file (assets in a process tree)?
   * The file structure stays reference-based — it is grafted only on screen, so it is not editable.
   */
  linkedPackageId?: string;
  /** Among ⚙ branches, a process · line (level without a file) — drawn as ▦ */
  linkedGroup?: boolean;
  /** Among ▦ branches, a line level — the menu gets an extra "+ Process" */
  linkedLine?: boolean;
  /** An asset's part (BoM) — no file, no behavior. Dimmed so it is not confused with assets (⚙); kind is Part */
  linkedPart?: boolean;
  /** The "BOM (n)" row that folds the parts under an asset */
  linkedPartGroup?: boolean;
  /**
   * One plain-language line next to the kind (English spec name) — only where beginners asked "what is this".
   * Currently only the HierarchicalStructures submodel: "Company · process structure" in a company file, "Parts structure (BOM)" in an asset file
   * (user, 2026-09-09: "change the text in parentheses so beginners can tell them apart"). The kind name itself stays verbatim from the spec
   */
  typeNote?: string;
  /** Long description shown when hovering typeNote */
  typeTitle?: string;
}
