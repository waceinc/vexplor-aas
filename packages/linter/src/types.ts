/**
 * Common linter types.
 *
 * The report structure follows the three-part error log of the KOSMO Validator exactly (linter spec §7).
 *   The {elementType} "{key}" violates the Kosmo rules: @ {kosmoPath}
 *   - {message}      ← what the problem is
 *   - {remedy}       ← instruction on how to fix it
 * However, we improve on a KOSMO flaw where the AASc-3a family omits the key — we always fill in key.
 */
import type { Environment, IdentifiableIndex, MetamodelDetection, MetamodelVersion, VisitedNode } from '@aas/core';
import type { LinterPolicy } from './policy.js';

/** Check layer — all three must be implemented to leave no gaps (spec §0) */
export type Layer = 'L1' | 'L2' | 'L3';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  layer: Layer;
  severity: Severity;
  /** modelType of the violating element. e.g. 'SubmodelElementCollection' */
  elementType: string;
  /** Identifier highlighted in the first part of the report (usually idShort, otherwise id) */
  key: string;
  /** RFC 6901 JSON Pointer */
  pointer: string;
  /** Path in KOSMO report format. e.g. /submodels/3(OperationalData)/submodelElements/0 */
  kosmoPath: string;
  /** What the problem is */
  message: string;
  /** Instruction on how to fix it */
  remedy?: string;
  /** Whether auto-fix (Quick Fix) is possible */
  fixable: boolean;
  /** If the rule's result depends on the chosen policy, records why (spec §5, 3 conflicts) */
  policyNote?: string;
}

/** Function a rule uses to report a result. ruleId and layer are filled in by the engine */
export type Report = (finding: Omit<Finding, 'ruleId' | 'layer'>) => void;

/** Information needed for package-level checks (L1). Omitted when linting only an Environment without an AASX */
export interface PackageContext {
  /** Absolute part names actually present in the ZIP */
  parts: string[];
  /** Part names declared as Override in [Content_Types].xml */
  contentTypeOverrides: string[];
  /**
   * Extensions (lowercase) declared as Default in [Content_Types].xml. Under the OPC spec, Default is also a valid declaration.
   * Optional to stay compatible with older callers
   */
  contentTypeDefaults?: string[];
  /** Part names referenced by relationships such as _rels/.rels */
  relationshipTargets: string[];
}

export interface LintContext {
  environment: Environment;
  policy: LinterPolicy;
  /** id → Identifiable index */
  index: IdentifiableIndex;
  /** Result of traversing all SubmodelElements (collect everything, then report in bulk — spec §6-4) */
  elements: VisitedNode[];
  package?: PackageContext;
  /** Metamodel version the checks judge by — always set (3.0 when the caller gave none) */
  metamodel: LintMetamodel;
}

/**
 * The version a file is judged by (IDTA-01001 V3.0 · V3.1 · V3.2) — the file's own version, not the newest one.
 * Constraints were removed (AASd-090 · AASd-120 in 3.1), added (AASd-137 · AASd-138 in 3.2) and loosened between
 * versions, so a rule that ignores the version raises false alarms on newer files.
 */
export interface LintMetamodel {
  version: MetamodelVersion;
  /**
   * How the version was decided: `namespace` = declared (XML), `content` = guessed from what the file holds (JSON has
   * no marker), `caller` = the caller said so without saying how, `default` = nobody said — 3.0 assumed.
   */
  source: MetamodelDetection['source'] | 'caller' | 'default';
  /** True when the version is a guess (from content, or the 3.0 default) rather than declared */
  inferred: boolean;
  /**
   * Versions the file may be, oldest first. One entry when declared or given; for a version guessed from content it
   * is every version whose schema holds the content (`fits`) — a JSON file without any 3.1 / 3.2 construct is a valid
   * 3.0 **and** 3.1 **and** 3.2 file, and nothing in it says which one its author meant.
   * Rules give such a file the benefit of the doubt: a constraint removed in 3.1 holds only if every candidate is 3.0;
   * a constraint added in 3.2 holds only if every candidate is 3.2 (see version.ts).
   */
  candidates: MetamodelVersion[];
}

/**
 * What a caller can pass: `readAasx(...).metamodel` as it is, or just `{ version }` (a store that remembers the
 * version a file came in).
 */
export interface LintMetamodelInput {
  version: MetamodelVersion;
  source?: MetamodelDetection['source'];
  inferred?: boolean;
  /** For a version guessed from content: every version whose schema holds the content */
  fits?: MetamodelVersion[];
}

export interface Rule {
  id: string;
  layer: Layer;
  /** One-line description. Used in the report summary and the rule list */
  title: string;
  /** Location in the source document */
  source: string;
  check(ctx: LintContext, report: Report): void;
}

export interface LintResult {
  findings: Finding[];
  /** Rule ID → number of violations */
  countByRule: Record<string, number>;
  countBySeverity: Record<Severity, number>;
  countByLayer: Record<Layer, number>;
  /** false if there is even one error */
  passed: boolean;
  /** Number of rules executed */
  rulesRun: number;
}
