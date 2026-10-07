/**
 * HTML 검증 결과서 — 기획서 Phase 3 산출물("Validator 검증 결과서 출력").
 *
 * PDF는 따로 만들지 않는다. **브라우저 인쇄가 곧 PDF**이고, PDF 라이브러리를 하나 들이면
 * 한글 글꼴 내장까지 따라붙는다(기획서 Ⅲ-2 라이선스·Ⅷ 인코딩). 그래서 인쇄 스타일을 함께 넣는다.
 *
 * 이 문서는 **우리 린터의 결과**다. KOSMO Validator 출력이 아니라는 점을 문서 안에 밝힌다 —
 * 제출처가 둘을 혼동하면 곤란하다.
 */
import { BRAND_LOGO_DATA_URI, BRAND_NAME } from '../docs/brand.js';
import type { LinterPolicy } from '../policy.js';
import type { Finding, LintResult, Severity } from '../types.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  error: '위반',
  warning: '경고',
  info: '참고',
};
/** 지적 목록은 심한 것부터 — 참고가 맨 위에 서면 검수자가 그것부터 읽는다(2026-09-09 실측) */
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** 값이 그대로 문서에 박히므로 반드시 막는다 — idShort·메시지에 <>&가 들어올 수 있다 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HtmlReportOptions {
  /** 대상 파일명 */
  title: string;
  /** 결과서 생성 시각(ISO). 호출부가 넘긴다 — 렌더러는 시간을 만들지 않는다 */
  generatedAt: string;
  /** 어떤 규정 해석으로 검사했는지 함께 싣는다 */
  policy?: LinterPolicy;
  /** 문서 아래에 붙일 비고 */
  note?: string;
  /** IRI 이관 대장(새 IRI → 원본 IRI) — KOSMO 우선 정책으로 옮긴 것을 제출물에 같이 밝힌다 */
  relocations?: Record<string, string>;
}

function summaryRow(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function findingRow(finding: Finding): string {
  return `
    <tr class="${finding.severity}">
      <td>${SEVERITY_LABEL[finding.severity]}</td>
      <td class="mono">${escapeHtml(finding.ruleId)}</td>
      <td>${escapeHtml(finding.elementType)}<br /><b>${escapeHtml(finding.key)}</b></td>
      <td class="mono path">${escapeHtml(finding.kosmoPath)}</td>
      <td>
        ${escapeHtml(finding.message)}
        ${finding.remedy ? `<div class="remedy">${escapeHtml(finding.remedy)}</div>` : ''}
        ${finding.policyNote ? `<div class="policy">※ ${escapeHtml(finding.policyNote)}</div>` : ''}
      </td>
      <td>${finding.fixable ? '자동 교정 가능' : '사람 판단'}</td>
    </tr>`;
}

export function formatHtmlReport(result: LintResult, options: HtmlReportOptions): string {
  const { error, warning, info } = result.countBySeverity;
  const ranked = Object.entries(result.countByRule).sort((a, b) => b[1] - a[1]);
  const policy = options.policy;
  const relocations = Object.entries(options.relocations ?? {});
  const relocationSection =
    relocations.length === 0
      ? ''
      : `<h2>IRI 이관 대장 (${relocations.length}건)</h2>
<p class="sub">KOSMO Validator가 IDTA 공식 IRI를 거부하므로 자체 IRI로 옮겼다(KTL §4와 충돌하는 자리 — 정책 KOSMO 우선). 원본은 여기 남아 있어 언제든 되돌릴 수 있다.</p>
<table>
  <thead><tr><th>지금 IRI</th><th>원본 IRI</th></tr></thead>
  <tbody>${relocations.map(([now, origin]) => `<tr><td class="mono">${escapeHtml(now)}</td><td class="mono">${escapeHtml(origin)}</td></tr>`).join('')}</tbody>
</table>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>AAS 검증 결과서 — ${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 12px/1.6 -apple-system, 'Malgun Gothic', sans-serif; color: #16191d; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5a6673; margin: 0 0 20px; }
  .verdict { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: 700; }
  .verdict.pass { background: #e3f6ee; color: #0d6b4b; }
  .verdict.fail { background: #fdeaea; color: #a11c1c; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; }
  th, td { border: 1px solid #d7dde4; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f5f8; white-space: nowrap; }
  tr.error td:first-child { color: #a11c1c; font-weight: 700; }
  tr.warning td:first-child { color: #8a5a00; font-weight: 700; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .path { word-break: break-all; max-width: 260px; }
  .remedy { color: #3d4b59; margin-top: 4px; }
  .policy { color: #8a5a00; margin-top: 4px; }
  .note { color: #5a6673; border-top: 1px solid #d7dde4; padding-top: 10px; margin-top: 24px; }
  @media print {
    body { margin: 12mm; }
    /* 표가 쪽을 넘어갈 때 행이 잘리지 않게 한다 */
    tr { break-inside: avoid; }
    thead { display: table-header-group; }
    /* 회사 표시 — 인쇄해서 제출하는 문서다 */
    .brand { margin-bottom: 6px; }
    .brand img { height: 26px; width: auto; }
  }
</style>
</head>
<body>
<div class="brand"><img src="${BRAND_LOGO_DATA_URI}" alt="${BRAND_NAME}"/></div>
<h1>AAS 검증 결과서</h1>
<p class="sub">
  ${escapeHtml(options.title)} · ${escapeHtml(options.generatedAt)} ·
  <span class="verdict ${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'}</span>
</p>

<h2>요약</h2>
<table>
  ${summaryRow('검사 규칙', `${result.rulesRun}종 (L1 패키지 · L2 AASd/AASc · L3 KOSMO)`)}
  ${summaryRow('위반', `${error}건`)}
  ${summaryRow('경고', `${warning}건`)}
  ${summaryRow('참고', `${info}건`)}
  ${summaryRow(
    '계층별',
    `L1 ${result.countByLayer.L1}건 · L2 ${result.countByLayer.L2}건 · L3 ${result.countByLayer.L3}건`,
  )}
</table>

${
  ranked.length === 0
    ? ''
    : `<h2>규칙별 집계</h2>
<table>
  <thead><tr><th>규칙</th><th>건수</th></tr></thead>
  <tbody>${ranked.map(([id, count]) => `<tr><td class="mono">${escapeHtml(id)}</td><td>${count}건</td></tr>`).join('')}</tbody>
</table>`
}

<h2>지적 목록</h2>
${
  result.findings.length === 0
    ? '<p>지적사항이 없습니다.</p>'
    : `<table>
  <thead>
    <tr><th>등급</th><th>규칙</th><th>대상</th><th>위치</th><th>내용과 조치</th><th>교정</th></tr>
  </thead>
  <tbody>${[...result.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).map(findingRow).join('')}</tbody>
</table>`
}

${
  policy
    ? `<h2>적용한 규정 해석</h2>
<p class="sub">KTL 규정·KOSMO Validator·표준 도구가 서로 어긋나는 5건은 정책으로 갈린다. 어느 쪽을 골랐는지 함께 남긴다.</p>
<table>
  ${summaryRow('① IRI 충돌', policy.iriConflict === 'kosmo-first' ? 'KOSMO 우선 — 화이트리스트 밖 IRI를 위반으로 본다' : 'IDTA 보존 — 공식 IRI는 경고로만')}
  ${summaryRow('② CD 정의', policy.cdDefinition === 'require-en' ? '영문 definition 필수' : '공란 허용(KTL §8)')}
  ${summaryRow('③ 언어 태그', policy.langTagTypo === 'fix-when-evidence' ? '중복 태그를 교정 대상으로 본다' : '원본 유지(KTL §7)')}
  ${summaryRow('④ SML 자식 idShort (AASd-120)', { warn: '경고 — KOSMO 판정에는 영향 없음', forbid: '위반 — 표준 도구·BaSyx 적재가 목표', allow: '참고 — 알고도 둔다' }[policy.smlChildIdShort])}
  ${summaryRow('⑤ 표준 템플릿 용어', policy.standardTemplateSemantics === 'kosmo-first' ? 'KOSMO 우선 — CD 없는 표준 용어를 위반으로 본다' : '보존 — 표준 용어는 참고로만')}
  ${summaryRow('자체 IRI 접두', policy.iriBase)}
  ${summaryRow('인정 IRDI 접두', policy.irdiPrefixes.join(' / '))}
</table>`
    : ''
}

${relocationSection}

<p class="note">
  이 문서는 <b>자체 규칙 린터</b>의 결과입니다. KOSMO Validator가 출력한 결과서가 아닙니다.
  Validator 실행 결과와 함께 확인하십시오.
  ${options.note ? `<br />${escapeHtml(options.note)}` : ''}
</p>
</body>
</html>`;
}
