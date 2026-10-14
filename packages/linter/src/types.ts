/**
 * Common linter types.
 *
 * The report structure follows the three-part error log of the KOSMO Validator exactly (linter spec §7).
 *   The {elementType} "{key}" violates the Kosmo rules: @ {kosmoPath}
 *   - {message}      ← what the problem is
 *   - {remedy}       ← instruction on how to fix it
 * However, we improve on a KOSMO flaw where the AASc-3a family omits the key — we always fill in key.
 */
import type { Environment, IdentifiableIndex, VisitedNode } from '@aas/core';
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
