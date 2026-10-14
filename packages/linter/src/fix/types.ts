/**
 * Quick Fix types.
 *
 * Designed as the unit for fixing a single finding in the authoring UI, not as a bulk multi-file correction.
 * Fixes must be reversible, so everything replaced and what it was replaced with is recorded -
 * this reversibility is a feature Package Explorer lacks, and our safeguard if a rule interpretation is overturned.
 */
import type { Environment } from '@aas/core';
import type { LinterPolicy } from '../policy.js';
import type { Finding, PackageContext } from '../types.js';

export interface AppliedFix {
  ruleId: string;
  pointer: string;
  /** Name of the element the finding pointed to (idShort, etc.) - the human-readable column in the preview table showing "what" is fixed */
  key?: string;
  elementType?: string;
  /** Human-readable description of the change */
  description: string;
  before?: unknown;
  after?: unknown;
}

/** Key identifying a single fix - used to apply only the ones selected in the preview */
export interface FixSelector {
  ruleId: string;
  pointer: string;
}

export interface SkippedFix {
  ruleId: string;
  pointer: string;
  reason: string;
}

/**
 * IRI migration register - holds the new IRI as key and the original IRI as value.
 * In actual work, 167 entries were recorded this way and kept in an immediately revertible state.
 */
export type RelocationLedger = Record<string, string>;

export interface FixResult {
  /** New Environment with the fixes applied (the input is not modified) */
  environment: Environment;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  relocations: RelocationLedger;
  /** How many lint -> fix iterations were run */
  rounds: number;
}

export interface FixInput {
  /** Change target. The fixer mutates this object directly */
  environment: Environment;
  finding: Finding;
  policy: LinterPolicy;
  package?: PackageContext;
  ledger: RelocationLedger;
}

export type FixOutcome =
  | { status: 'applied'; description: string; before?: unknown; after?: unknown }
  | { status: 'skipped'; reason: string };

export type Fixer = (input: FixInput) => FixOutcome;
