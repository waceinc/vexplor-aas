/**
 * 검증 결과서 검증.
 *
 * 결과서는 제출물이다 — 숫자가 틀리거나 값이 새어 문서가 깨지면 그대로 밖으로 나간다.
 * 그래서 집계와 이스케이프를 못박아 둔다.
 */
import { readAasx } from '@aas/aasx';
import { ALL_RULES, DEFAULT_POLICY, escapeHtml, formatHtmlReport, lint } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = readAasx(new Uint8Array(readFileSync(root + '01-롤포밍기-공34.aasx')));

const options = {
  title: '01-롤포밍기-공34.aasx',
  generatedAt: '2026-08-21T00:00:00.000Z',
  policy: DEFAULT_POLICY,
};

describe('HTML 검증 결과서', () => {
  it('골든 파일은 PASS로 나온다', () => {
    const result = lint(golden.environment, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);
    expect(html).toContain('>PASS<');
    expect(html).toContain('01-롤포밍기-공34.aasx');
    expect(html).toContain(`검사 규칙</th><td>${result.rulesRun}종`);
  });

  it('위반이 있으면 FAIL과 함께 규칙·위치·조치가 실린다', () => {
    const env = structuredClone(golden.environment);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    const result = lint(env, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);

    expect(html).toContain('>FAIL<');
    expect(html).toContain('KOSMO-AAS-6');
    expect(html).toContain('assetKind를 Type으로 지정하십시오.');
    expect(html).toContain('자동 교정 가능');
  });

  it('적용한 규정 해석을 함께 싣는다 — 충돌 3건을 숨기지 않는다', () => {
    const result = lint(golden.environment, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);
    expect(html).toContain('KOSMO 우선');
    expect(html).toContain(DEFAULT_POLICY.iriBase);
  });

  it('Validator 결과서가 아니라는 것을 문서 안에 밝힌다', () => {
    const html = formatHtmlReport(lint(golden.environment, ALL_RULES), options);
    expect(html).toContain('KOSMO Validator가 출력한 결과서가 아닙니다');
  });

  it('인쇄가 곧 PDF다 — 인쇄 스타일이 들어 있다', () => {
    const html = formatHtmlReport(lint(golden.environment, ALL_RULES), options);
    expect(html).toContain('@media print');
    expect(html).toContain('break-inside: avoid');
  });

  it('값에 든 <>&를 막는다 — 문서가 깨지거나 스크립트가 섞이면 안 된다', () => {
    expect(escapeHtml('<script>"x" & y')).toBe('&lt;script&gt;&quot;x&quot; &amp; y');

    const env = structuredClone(golden.environment);
    env.submodels![0]!.idShort = '<img src=x onerror=alert(1)>';
    const html = formatHtmlReport(lint(env, ALL_RULES), options);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
