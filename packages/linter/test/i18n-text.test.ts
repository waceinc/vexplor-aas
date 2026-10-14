/**
 * English server text — the linter's report, auto-fix messages, documentation data, rule screen and errors.
 *
 * Pins down two things.
 *  (1) When English is selected, **text we wrote** contains not a single Hangul character.
 *      Values from the file (idShort · id · description · file name) may legitimately be Korean — those are stripped out first.
 *  (2) Korean (the default) does not change — compared against a snapshot. If wiring in translation alters even one character of the original, it shows here.
 */
import { readAasx } from '@aas/aasx';
import { setLangSource, type Environment } from '@aas/core';
import {
  ALL_RULES,
  BRAND_LOGO_DATA_URI,
  DEFAULT_POLICY,
  addChild,
  applyFixes,
  bundleLinkage,
  escapeHtml,
  formatHtmlReport,
  formatReport,
  formatSummary,
  lint,
  lintAndFix,
  linkageCsv,
  overviewUml,
  submodelUml,
  parsePolicy,
  planFor,
  removeChild,
  renameEnvironment,
  ruleCatalog,
  scaffoldEnvironment,
  submodelInfo,
  submodelTable,
  submodelTables,
  submodelTablesHtml,
  tableCsv,
  tableHtml,
  type Finding,
} from '@aas/linter';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const NAME = '01-롤포밍기-공34.aasx';
const golden = readAasx(new Uint8Array(readFileSync(root + NAME)));
const other = readAasx(new Uint8Array(readFileSync(root + '03-SPR장비-뿌80.aasx')));

const HANGUL = /[가-힣]/;

afterEach(() => setLangSource(() => 'ko'));

/** Injects several defects — so findings, fixes and the migration log all appear in the report */
function broken(): Environment {
  const env = structuredClone(golden.environment);
  const shell = env.assetAdministrationShells![0]!;
  shell.assetInformation.assetKind = 'Instance';
  shell.assetInformation.globalAssetId = 'urn:wrong';
  const sm = env.submodels![0]!;
  sm.kind = 'Instance';
  const cd = env.conceptDescriptions![0]!;
  cd.id = 'urn:wrong:cd';
  return env;
}

/** All text inside the file — the values to strip from the output */
function fileStrings(...environments: unknown[]): string[] {
  const found = new Set<string>([NAME]);
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (HANGUL.test(value)) found.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  environments.forEach(walk);
  return [...found].sort((a, b) => b.length - a.length);
}

/** Removes values that came from the file and returns the remaining Hangul spots */
function leftoverHangul(text: string, values: readonly string[]): string[] {
  let rest = text;
  for (const value of values) {
    rest = rest.split(escapeHtml(value)).join('').split(value).join('');
  }
  return rest
    .split('\n')
    .filter((line) => HANGUL.test(line))
    .map((line) => line.trim().slice(0, 160));
}

/** Collects all text this area produces (linter core · report · fixes · documentation data) */
function renderAll(): Record<string, string> {
  const env = broken();
  const before = lint(env, ALL_RULES, { package: golden.opc });
  const fixed = lintAndFix(env, { package: golden.opc, includeWarnings: true });
  // Skip reasons — findings with no location · rules without a fixer
  const ghost = (ruleId: string, pointer: string): Finding => ({ ...before.findings[0]!, ruleId, pointer, fixable: true, severity: 'error' });
  const skipped = applyFixes(env, [
    ghost('KOSMO-AAS-1', '/nowhere'),
    ghost('KOSMO-SM-3', '/nowhere'),
    ghost('KOSMO-CD-2', '/nowhere'),
    ghost('KOSMO-SME-5', '/nowhere'),
    ghost('PKG-EMPTY-ARRAY', '/nowhere'),
    ghost('NO-SUCH-RULE', '/nowhere'),
  ]);

  const submodel = golden.environment.submodels!.find((s) => planFor(s).kind === 'table') ?? golden.environment.submodels![0]!;
  const info = golden.environment.submodels!.find((s) => planFor(s).kind === 'info') ?? submodel;
  const rows = submodelTable(golden.environment, submodel);

  const errors: string[] = [];
  const attempt = (fn: () => unknown): void => {
    try {
      fn();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };
  attempt(() => parsePolicy('{'));
  attempt(() => parsePolicy('[]'));
  attempt(() => parsePolicy('{"nope": 1}'));
  attempt(() => parsePolicy('{"iriConflict": "x"}'));
  attempt(() => parsePolicy('{"iriBase": ""}'));
  attempt(() => parsePolicy('{"requiredSubmodels": [1]}'));
  attempt(() => parsePolicy('{"submodelCountRange": [1]}'));
  attempt(() => parsePolicy('{"submodelCountRange": [9, 1]}'));
  attempt(() => scaffoldEnvironment({ assetName: '1bad' } as Parameters<typeof scaffoldEnvironment>[0]));
  attempt(() => renameEnvironment({} as Environment, 'X', DEFAULT_POLICY.iriBase));
  const hierarchy = golden.environment.submodels!.find((s) => s.idShort === 'HierarchicalStructures');
  if (hierarchy) {
    attempt(() => addChild(hierarchy, { name: ' ', globalAssetId: 'x' } as Parameters<typeof addChild>[1], DEFAULT_POLICY.iriBase));
    attempt(() => addChild(hierarchy, { name: 'X', globalAssetId: 'x' } as Parameters<typeof addChild>[1], DEFAULT_POLICY.iriBase, ['nowhere']));
    attempt(() => removeChild(hierarchy, 'nowhere'));
  }

  const catalog = ruleCatalog();
  return {
    html: formatHtmlReport(fixed.before, {
      title: NAME,
      generatedAt: '2026-08-21T00:00:00.000Z',
      policy: DEFAULT_POLICY,
      relocations: fixed.relocations,
    }).replace(BRAND_LOGO_DATA_URI, '(logo)'),
    htmlPass: formatHtmlReport(lint(golden.environment, ALL_RULES, { package: golden.opc }), {
      title: NAME,
      generatedAt: '2026-08-21T00:00:00.000Z',
    }).replace(BRAND_LOGO_DATA_URI, '(logo)'),
    text: formatReport(before, { title: NAME, limit: 3 }),
    textPass: formatReport(lint(golden.environment, ALL_RULES, { package: golden.opc })),
    summary: formatSummary(before, NAME),
    fixes: [...fixed.applied.map((item) => item.description), ...skipped.skipped.map((item) => item.reason)].join('\n'),
    // Rule id · title · source belong to the rules side — here we only check fields this area writes
    catalog: JSON.stringify({ layers: catalog.layers, conflicts: catalog.conflicts, conventions: catalog.conventions, verdict: catalog.verdict }, null, 1),
    table: [planFor(submodel).reason, planFor(info).reason, tableHtml(rows), tableCsv(rows), JSON.stringify(submodelInfo(info))].join('\n'),
    smt: submodelTablesHtml(submodelTables(golden.environment, submodel), { submodelName: submodel.idShort ?? '' }),
    uml: [overviewUml(golden.environment), submodelUml(golden.environment.submodels!.find((s) => s.idShort === 'DigitalNameplate')!, { maxAttributes: 3 })].join('\n'),
    bundle: (() => {
      const linkage = bundleLinkage([
        { name: 'A', globalAssetId: 'a', environment: golden.environment },
        { name: 'B', globalAssetId: 'b', environment: other.environment },
      ]);
      return [linkageCsv(linkage), ...linkage.findings.map((f) => f.message)].join('\n');
    })(),
    errors: errors.join('\n'),
  };
}

describe('English server text — linter core · report · fixes', () => {
  it('with English selected, no Hangul remains in text we wrote', () => {
    setLangSource(() => 'en');
    const values = fileStrings(golden.environment, other.environment, broken());
    const outputs = renderAll();
    for (const [name, text] of Object.entries(outputs)) {
      expect(text.length, name).toBeGreaterThan(0);
      expect(leftoverHangul(text, values), name).toEqual([]);
    }
    expect(outputs['html']).toContain('<html lang="en">');
    expect(outputs['html']).toContain('AAS validation report');
    expect(outputs['fixes']).toContain('Changed assetKind to Type.');
  });

  it('Important: the stripping actually works — Korean output still has remaining Hangul (positive control)', () => {
    const values = fileStrings(golden.environment, other.environment, broken());
    const outputs = renderAll();
    for (const name of ['html', 'text', 'fixes', 'catalog', 'table', 'bundle', 'uml', 'errors']) {
      expect(leftoverHangul(outputs[name]!, values).length, name).toBeGreaterThan(0);
    }
    expect(outputs['html']).toContain('<html lang="ko">');
  });

  it('Korean (the default) does not change', () => {
    expect(renderAll()).toMatchSnapshot();
  });
});
