/** 린터 실행기 — 전수 수집 후 일괄 보고(명세 §6-4) */
import { collectElements, indexIdentifiables, type Environment } from '@aas/core';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';
import type {
  Finding,
  Layer,
  LintContext,
  LintResult,
  PackageContext,
  Rule,
  Severity,
} from './types.js';

export interface LintOptions {
  policy?: Partial<LinterPolicy>;
  /** L1 패키지 검사용 정보. 없으면 해당 규칙은 조용히 건너뛴다 */
  package?: PackageContext;
  /** 실행할 규칙을 제한한다 (규칙 ID 접두 매칭) */
  only?: string[];
  /** 제외할 규칙 */
  exclude?: string[];
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

  // 문서 순서대로 읽히도록 경로 기준 정렬 — Validator 리포트와 대조하기 쉬워진다
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
