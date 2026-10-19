/** Linter runner - collects everything, then reports in one batch (spec §6-4) */
import { collectElements, indexIdentifiables, type Environment } from '@aas/core';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';
import type {
  Finding,
  Layer,
  LintContext,
  LintMetamodelInput,
  LintResult,
  PackageContext,
  Rule,
  Severity,
} from './types.js';
import { resolveMetamodel } from './version.js';

export interface LintOptions {
  policy?: Partial<LinterPolicy>;
  /** Information for L1 package checks. If absent, those rules are silently skipped */
  package?: PackageContext;
  /** Restrict which rules run (rule ID prefix match) */
  only?: string[];
  /** Rules to exclude */
  exclude?: string[];
  /**
   * Metamodel version of the file — pass `readAasx(...).metamodel`. Without it the file is judged as 3.0, which is
   * what every caller got before versions were told apart.
   */
  metamodel?: LintMetamodelInput;
}

export function lint(
  environment: Environment,
  rules: readonly Rule[],
  options: LintOptions = {},
): LintResult {
  const policy: LinterPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const ctx: LintContext = {
    environment,
    policy,
    index: indexIdentifiables(environment),
    elements: collectElements(environment),
    metamodel: resolveMetamodel(options.metamodel),
  };
  if (options.package) ctx.package = options.package;

  const selected = rules.filter((r) => {
    if (options.only && !options.only.some((p) => r.id.startsWith(p))) return false;
    if (options.exclude?.some((p) => r.id.startsWith(p))) return false;
    return true;
  });

  const findings: Finding[] = [];
  for (const rule of selected) {
    rule.check(ctx, (f) => {
      findings.push({ ...f, ruleId: rule.id, layer: rule.layer });
    });
  }

  // Sort by path so results read in document order - makes them easier to compare against the Validator report
  findings.sort((a, b) => a.pointer.localeCompare(b.pointer) || a.ruleId.localeCompare(b.ruleId));

  const countByRule: Record<string, number> = {};
  const countBySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const countByLayer: Record<Layer, number> = { L1: 0, L2: 0, L3: 0 };
  for (const f of findings) {
    countByRule[f.ruleId] = (countByRule[f.ruleId] ?? 0) + 1;
    countBySeverity[f.severity] += 1;
    countByLayer[f.layer] += 1;
  }

  return {
    findings,
    countByRule,
    countBySeverity,
    countByLayer,
    passed: countBySeverity.error === 0,
    rulesRun: selected.length,
  };
}
