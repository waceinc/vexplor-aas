/**
 * Tests for the validation report.
 *
 * The report is a submission deliverable — wrong numbers, or values leaking through and breaking the
 * document, go straight out the door. So the counts and the escaping are pinned down here.
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

describe('HTML validation report', () => {
  it('the golden file comes out as PASS', () => {
    const result = lint(golden.environment, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);
    expect(html).toContain('>PASS<');
    expect(html).toContain('01-롤포밍기-공34.aasx');
    expect(html).toContain(`검사 규칙</th><td>${result.rulesRun}종`);
  });

  it('with violations it shows FAIL along with rule, location and action', () => {
    const env = structuredClone(golden.environment);
    env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    const result = lint(env, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);

    expect(html).toContain('>FAIL<');
    expect(html).toContain('KOSMO-AAS-6');
    expect(html).toContain('assetKind를 Type으로 지정하십시오.');
    expect(html).toContain('자동 교정 가능');
  });

  it('includes the applied rule interpretation — the 3 conflicts are not hidden', () => {
    const result = lint(golden.environment, ALL_RULES, { package: golden.opc });
    const html = formatHtmlReport(result, options);
    expect(html).toContain('KOSMO 우선');
    expect(html).toContain(DEFAULT_POLICY.iriBase);
  });

  it('states in the document that it is not a Validator report', () => {
    const html = formatHtmlReport(lint(golden.environment, ALL_RULES), options);
    expect(html).toContain('KOSMO Validator가 출력한 결과서가 아닙니다');
  });

  it('printing is the PDF path — print styles are included', () => {
    const html = formatHtmlReport(lint(golden.environment, ALL_RULES), options);
    expect(html).toContain('@media print');
    expect(html).toContain('break-inside: avoid');
  });

  it('escapes <>& in values — the document must not break or get script injected', () => {
    expect(escapeHtml('<script>"x" & y')).toBe('&lt;script&gt;&quot;x&quot; &amp; y');

    const env = structuredClone(golden.environment);
    env.submodels![0]!.idShort = '<img src=x onerror=alert(1)>';
    const html = formatHtmlReport(lint(env, ALL_RULES), options);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
