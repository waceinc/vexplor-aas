/**
 * 서버 글의 영어 — 린터가 만드는 결과서 · 자동 고치기 문구 · 문서용 자료 · 규칙 화면 · 오류.
 *
 * 두 가지를 못박는다.
 *  ① 영어로 고르면 **우리가 쓴 글**에는 한글이 한 글자도 남지 않는다.
 *     파일에서 온 값(idShort · id · 설명 · 파일 이름)은 한글이어도 맞다 — 그 값들은 미리 걷어 내고 본다.
 *  ② 한국어(기본)는 바뀌지 않는다 — 스냅샷과 견준다. 번역을 끼우다 원문 한 글자가 바뀌면 여기서 드러난다.
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

/** 결함을 여럿 넣는다 — 지적 · 고치기 · 이관 대장이 결과서에 다 실리게 */
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

/** 파일 안의 모든 글자 — 출력에서 걷어 낼 값 */
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

/** 파일에서 온 값을 지우고 남은 한글 자리를 돌려준다 */
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

/** 이 영역(린터 본체 · 결과서 · 고치기 · 문서 자료)이 만드는 글을 한데 모은다 */
function renderAll(): Record<string, string> {
  const env = broken();
  const before = lint(env, ALL_RULES, { package: golden.opc });
  const fixed = lintAndFix(env, { package: golden.opc, includeWarnings: true });
  // 건너뛴 사유 — 가리키는 자리가 없는 지적 · 교정기가 없는 규칙
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
    // 규칙 id · 제목 · 근거는 규칙 쪽 몫이다 — 여기서는 이 영역이 쓰는 칸만 본다
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

describe('서버 글의 영어 — 린터 본체 · 결과서 · 고치기', () => {
  it('영어로 고르면 우리가 쓴 글에 한글이 남지 않는다', () => {
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

  it('🔴 걷어 내는 장치가 실제로 잡는다 — 한국어 출력에는 남은 한글이 있다(양성 대조)', () => {
    const values = fileStrings(golden.environment, other.environment, broken());
    const outputs = renderAll();
    for (const name of ['html', 'text', 'fixes', 'catalog', 'table', 'bundle', 'uml', 'errors']) {
      expect(leftoverHangul(outputs[name]!, values).length, name).toBeGreaterThan(0);
    }
    expect(outputs['html']).toContain('<html lang="ko">');
  });

  it('한국어(기본)는 바뀌지 않는다', () => {
    expect(renderAll()).toMatchSnapshot();
  });
});
