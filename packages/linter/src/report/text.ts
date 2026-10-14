/**
 * 텍스트 리포트.
 *
 * KOSMO Validator 에러 로그의 세 토막 구조를 그대로 따른다(명세 §7) — 결과서 제출이 의무이므로
 * 동일 구조를 유지하는 편이 안전하다. 다만 KOSMO가 AASc-3a 계열에서 key를 빼먹는 결함은 개선해
 * 우리는 항상 key를 출력한다.
 */
import type { Finding, LintResult, Severity } from '../types.js';
import { fill, tr } from '@aas/core';

/** 등급 글자 — 언어가 요청마다 다르므로 부를 때 옮긴다 */
const severityLabel = (severity: Severity): string =>
  ({ error: tr('위반'), warning: tr('경고'), info: tr('참고') })[severity];

/** 한 건을 KOSMO 리포트 형식으로 출력한다 */
export function formatFinding(finding: Finding): string {
  const head =
    `The ${finding.elementType} "${finding.key}" violates the ${finding.layer} rules ` +
    `[${finding.ruleId}]: @ ${finding.kosmoPath}`;
  const lines = [head, `- ${finding.message}`];
  if (finding.remedy) lines.push(`- ${finding.remedy}`);
  if (finding.policyNote) lines.push(`  ※ ${finding.policyNote}`);
  return lines.join('\n');
}

export interface TextReportOptions {
  /** 출력할 최대 건수. 기본은 전부 */
  limit?: number;
  /** 대상 파일명 등 제목에 넣을 문구 */
  title?: string;
}

export function formatReport(result: LintResult, options: TextReportOptions = {}): string {
  const { limit, title } = options;
  const out: string[] = [];

  if (title) out.push(`# ${title}`, '');

  const { error, warning, info } = result.countBySeverity;
  out.push(
    fill(tr('검사 규칙 {0}종 · 위반 {1}건 · 경고 {2}건 · 참고 {3}건'), { 0: result.rulesRun, 1: error, 2: warning, 3: info }) +
      `  → ${result.passed ? 'PASS' : 'FAIL'}`,
  );
  out.push(
    fill(tr('계층별: L1 패키지 {0}건 · L2 제약조건 {1}건 · L3 KOSMO {2}건'), {
      0: result.countByLayer.L1,
      1: result.countByLayer.L2,
      2: result.countByLayer.L3,
    }),
  );

  if (result.findings.length === 0) {
    out.push('', tr('지적사항이 없습니다.'));
    return out.join('\n');
  }

  out.push('', `## ${tr('규칙별 집계')}`, '');
  const ranked = Object.entries(result.countByRule).sort((a, b) => b[1] - a[1]);
  for (const [ruleId, count] of ranked) {
    out.push(`  ${ruleId.padEnd(22)} ${fill(tr('{0}건'), { 0: String(count).padStart(4) })}`);
  }

  out.push('', `## ${tr('상세')}`, '');
  const shown = limit === undefined ? result.findings : result.findings.slice(0, limit);
  for (const f of shown) {
    out.push(`[${severityLabel(f.severity)}] ${formatFinding(f)}`, '');
  }
  if (limit !== undefined && result.findings.length > limit) {
    out.push(`... ${fill(tr('외 {0}건'), { 0: result.findings.length - limit })}`);
  }

  return out.join('\n');
}

/** 한 줄 요약 — CI 로그용 */
export function formatSummary(result: LintResult, label = ''): string {
  const { error, warning } = result.countBySeverity;
  const mark = result.passed ? 'PASS' : 'FAIL';
  const name = label ? `${label} ` : '';
  return `${mark} ${name}${fill(tr('위반 {0}건 · 경고 {1}건'), { 0: error, 1: warning })}`;
}
