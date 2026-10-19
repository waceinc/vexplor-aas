/**
 * Checks follow the metamodel version of the file (IDTA-01001 V3.0 · V3.1 · V3.2).
 *
 * Important: the bar is the IDTA's own generated examples (tests/fixtures/idta-metamodel). They are valid data of
 *    their version, so a finding that only appears when a 3.1 or 3.2 example is judged by 3.0 rules is a false alarm
 *    — 99 AASd-090 errors on the full 3.1.2 example set before this change. And a caller that passes no version must
 *    get exactly what it got before (3.0), so nothing already shipped changes its verdict.
 */
import { parseEnvironmentXml, readAasx, xmlMetamodelVersion } from '@aas/aasx';
import { detectMetamodelVersion, parseEnvironment, setLangSource, type Environment, type MetamodelVersion } from '@aas/core';
import { ALL_RULES, applyFixes, L2_RULES, lint, type Finding, type LintOptions } from '@aas/linter';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const ROOT = join(fixtures, 'idta-metamodel');
const VERSIONS: MetamodelVersion[] = ['3.0', '3.1', '3.2'];

interface Example {
  name: string;
  env: Environment;
  /** What the reader decides for this example: the XML namespace, or content for JSON */
  metamodel: NonNullable<LintOptions['metamodel']>;
}

function examples(version: MetamodelVersion): Example[] {
  const out: Example[] = [];
  for (const form of ['json', 'xml'] as const) {
    const dir = join(ROOT, version, form);
    for (const cls of readdirSync(dir).sort()) {
      for (const file of readdirSync(join(dir, cls)).sort()) {
        const text = readFileSync(join(dir, cls, file), 'utf8');
        const env = form === 'json' ? parseEnvironment(text) : parseEnvironmentXml(text);
        const detected = detectMetamodelVersion(env);
        const declared = form === 'xml' ? xmlMetamodelVersion(text) : undefined;
        out.push({
          name: `${form}/${cls}/${file}`,
          env,
          metamodel: declared ? { ...detected, version: declared, source: 'namespace', inferred: false } : detected,
        });
      }
    }
  }
  return out;
}

const ALL = Object.fromEntries(VERSIONS.map((v) => [v, examples(v)])) as Record<MetamodelVersion, Example[]>;

function count(findings: readonly Finding[], ruleId?: string): number {
  return findings.filter((f) => f.severity !== 'info' && (ruleId === undefined || f.ruleId === ruleId)).length;
}

function tally(list: Example[], withVersion: boolean): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const ex of list) {
    const result = lint(ex.env, ALL_RULES, withVersion ? { metamodel: ex.metamodel } : {});
    for (const f of result.findings) {
      if (f.severity === 'info') continue;
      const key = `${f.ruleId}:${f.severity}`;
      acc[key] = (acc[key] ?? 0) + 1;
    }
  }
  return acc;
}

const submodel = (elements: unknown[], kind?: string): Environment =>
  ({
    submodels: [
      {
        modelType: 'Submodel',
        id: 'https://example.com/sm/1',
        idShort: 'Sm',
        ...(kind ? { kind } : {}),
        submodelElements: elements,
      },
    ],
  }) as unknown as Environment;

const at = (version: MetamodelVersion): LintOptions => ({ metamodel: { version, source: 'namespace', inferred: false } });
const ids = (env: Environment, options: LintOptions, rules = ALL_RULES, ruleId?: string) =>
  lint(env, rules, options)
    .findings.filter((f) => ruleId === undefined || f.ruleId === ruleId)
    .map((f) => [f.ruleId, f.severity, f.pointer]);

afterEach(() => setLangSource(() => 'ko'));

describe('official examples — judged by their own version', () => {
  it('V3.1 and V3.2 examples: 0 AASd-090 findings (the constraint was removed in 3.1)', () => {
    for (const version of ['3.1', '3.2'] as const) {
      const found = ALL[version].flatMap((ex) =>
        lint(ex.env, L2_RULES, { metamodel: ex.metamodel }).findings.filter((f) => f.ruleId === 'AASd-090').map(() => ex.name),
      );
      expect(found, `V${version}`).toEqual([]);
    }
  });

  it('V3.1 and V3.2 examples without a version still show the 3.0 verdict — the version really is what changes it', () => {
    // Positive control: if this ever drops to 0 the test above proves nothing
    for (const version of ['3.1', '3.2'] as const) {
      const without = ALL[version].reduce((n, ex) => n + count(lint(ex.env, L2_RULES).findings, 'AASd-090'), 0);
      expect(without, `V${version}`).toBeGreaterThan(0);
    }
  });

  it('V3.0 examples known to be 3.0 (XML namespace, or the caller says 3.0): the verdict equals the verdict with no version', () => {
    const known = ALL['3.0'].map((ex) => ({ ...ex, metamodel: { version: '3.0' as const } }));
    expect(tally(known, true)).toEqual(tally(ALL['3.0'], false));
    const xml = ALL['3.0'].filter((ex) => ex.name.startsWith('xml/'));
    expect(xml.every((ex) => ex.metamodel.source === 'namespace')).toBe(true);
    expect(tally(xml, true)).toEqual(tally(xml, false));
  });

  it('no example is told its version does not fit, and the 3.2-only constraints find nothing in valid data', () => {
    for (const version of VERSIONS) {
      for (const ex of ALL[version]) {
        const found = lint(ex.env, ALL_RULES, { metamodel: ex.metamodel }).findings.filter((f) =>
          ['PKG-MM-VERSION', 'AASd-137', 'AASd-138'].includes(f.ruleId),
        );
        expect(found.map((f) => `${ex.name} ${f.ruleId} ${f.pointer}`)).toEqual([]);
      }
    }
  });
});

describe('golden equipment files', () => {
  const load = (name: string) => readAasx(new Uint8Array(readFileSync(fixtures + name)));

  it('the XML golden file (3.0 namespace): the declared version gives exactly the findings of no version', () => {
    const pkg = load('01-roll-forming-machine-xml.aasx');
    expect(pkg.metamodel).toMatchObject({ version: '3.0', source: 'namespace' });
    const plain = lint(pkg.environment, ALL_RULES, { package: pkg.opc });
    const versioned = lint(pkg.environment, ALL_RULES, { package: pkg.opc, metamodel: pkg.metamodel });
    expect(plain.findings.length).toBeGreaterThan(0);
    expect(versioned.findings).toEqual(plain.findings);
  });

  for (const name of ['01-roll-forming-machine.aasx', '03-spr-riveting-machine.aasx', '11-cobot-6-axis.aasx']) {
    it(`${name} (JSON, no version marker): only the AASd-120 warnings go — the file is valid 3.1 as it stands`, () => {
      const pkg = load(name);
      expect(pkg.metamodel).toMatchObject({ version: '3.0', source: 'content', fits: ['3.0', '3.1', '3.2'] });
      const plain = lint(pkg.environment, ALL_RULES, { package: pkg.opc });
      const versioned = lint(pkg.environment, ALL_RULES, { package: pkg.opc, metamodel: pkg.metamodel });
      expect(count(plain.findings, 'AASd-120')).toBeGreaterThan(0);
      expect(versioned.findings).toEqual(plain.findings.filter((f) => f.ruleId !== 'AASd-120'));
      // Told it is 3.0, the 3.0 constraint is back
      const as30 = lint(pkg.environment, ALL_RULES, { package: pkg.opc, metamodel: { version: '3.0' } });
      expect(as30.findings).toEqual(plain.findings);
    });
  }
});

describe('a version guessed from content gets the benefit of the doubt', () => {
  const listWithNamedChild = (extra: unknown[] = []) =>
    submodel([
      {
        modelType: 'SubmodelElementList',
        idShort: 'List',
        typeValueListElement: 'Property',
        valueTypeListElement: 'xs:string',
        value: [{ modelType: 'Property', idShort: 'Item', valueType: 'xs:string', value: 'x' }],
      },
      ...extra,
    ]);

  it('content that also fits 3.1 is not held to AASd-120', () => {
    const env = listWithNamedChild();
    expect(ids(env, { metamodel: detectMetamodelVersion(env) }, L2_RULES, 'AASd-120')).toEqual([]);
  });

  it('content that fits only 3.0 (a one-letter idShort) is held to AASd-120, and the note says the version was guessed', () => {
    const env = listWithNamedChild([{ modelType: 'Property', idShort: 'V', valueType: 'xs:string', value: 'x' }]);
    const detected = detectMetamodelVersion(env);
    expect(detected.fits).toEqual(['3.0']);
    const found = lint(env, L2_RULES, { metamodel: detected }).findings.filter((f) => f.ruleId === 'AASd-120');
    expect(found).toHaveLength(1);
    expect(found[0]!.policyNote).toContain('3.0');
  });

  it('a 3.2 constraint holds only when the content needs 3.2', () => {
    const env = submodel([{ modelType: 'SubmodelElementList', idShort: 'List', typeValueListElement: 'Property', value: [] }], 'Template');
    expect(ids(env, { metamodel: detectMetamodelVersion(env) }, L2_RULES, 'AASd-138')).toEqual([]);
    expect(ids(env, at('3.2'), L2_RULES, 'AASd-138')).toHaveLength(1);
  });
});

describe('AASd-120 · AASd-090 — 3.0 only', () => {
  const listWithNamedChild = () =>
    submodel([
      {
        modelType: 'SubmodelElementList',
        idShort: 'List',
        typeValueListElement: 'Property',
        valueTypeListElement: 'xs:string',
        value: [{ modelType: 'Property', idShort: 'Item', valueType: 'xs:string', value: 'x' }],
      },
    ]);

  it('a named list child is a warning in 3.0 and nothing in 3.1 / 3.2', () => {
    expect(ids(listWithNamedChild(), at('3.0'), L2_RULES, 'AASd-120')).toHaveLength(1);
    expect(ids(listWithNamedChild(), at('3.1'), L2_RULES, 'AASd-120')).toEqual([]);
    expect(ids(listWithNamedChild(), at('3.2'), L2_RULES, 'AASd-120')).toEqual([]);
  });

  it('a category outside CONSTANT · PARAMETER · VARIABLE is an error in 3.0 only', () => {
    const env = submodel([{ modelType: 'Property', idShort: 'P', category: 'OTHER', valueType: 'xs:string', value: 'x' }]);
    expect(ids(env, at('3.0'), L2_RULES, 'AASd-090')).toHaveLength(1);
    expect(ids(env, at('3.1'), L2_RULES, 'AASd-090')).toEqual([]);
  });
});

describe('PKG-FILE-URI — by version', () => {
  const file = (value: string) =>
    submodel([{ modelType: 'File', idShort: 'Doc', contentType: 'application/pdf', value }]);

  it('3.0 keeps its rule: a value without a scheme is an error', () => {
    expect(ids(file('/aasx/files/a.pdf'), at('3.0'), ALL_RULES, 'PKG-FILE-URI')).toEqual([
      ['PKG-FILE-URI', 'error', '/submodels/0/submodelElements/0/value'],
    ]);
  });

  it('3.1 accepts relative references the 3.1 schema accepts', () => {
    for (const value of ['/aasx/files/a.pdf', './Specification.pdf', 'aasx/files/x.pdf', 'file:///aasx/a.pdf']) {
      expect(ids(file(value), at('3.1'), ALL_RULES, 'PKG-FILE-URI'), value).toEqual([]);
    }
  });

  it('3.1 points out spaces and non-ASCII letters, and says to percent-encode on export', () => {
    for (const value of ['/aasx/files/설명서.pdf', 'file:///aasx/a b.pdf']) {
      const found = lint(file(value), ALL_RULES, at('3.2')).findings.filter((f) => f.ruleId === 'PKG-FILE-URI');
      expect(found.map((f) => f.severity), value).toEqual(['warning']);
      expect(found[0]!.remedy).toContain('%');
      expect(found[0]!.fixable).toBe(false);
    }
  });

  it('3.1: a value that no encoding turns into a URI reference is an error', () => {
    const found = lint(file('aasx\\files\\a.pdf'), ALL_RULES, at('3.1')).findings.filter((f) => f.ruleId === 'PKG-FILE-URI');
    expect(found.map((f) => f.severity)).toEqual(['error']);
  });
});

describe('idShort pattern — by version (AASd-002, checked through KOSMO-*-1)', () => {
  const property = (idShort: string) => submodel([{ modelType: 'Property', idShort, valueType: 'xs:string', value: 'x' }]);

  it('3.0: a hyphen is not allowed, one letter is', () => {
    expect(ids(property('Rated-Voltage'), at('3.0'), ALL_RULES, 'KOSMO-SME-1')).toHaveLength(1);
    expect(ids(property('V'), at('3.0'), ALL_RULES, 'KOSMO-SME-1')).toEqual([]);
  });

  it('3.1: a hyphen is allowed, one letter is not', () => {
    expect(ids(property('Rated-Voltage'), at('3.1'), ALL_RULES, 'KOSMO-SME-1')).toEqual([]);
    expect(ids(property('V'), at('3.1'), ALL_RULES, 'KOSMO-SME-1')).toHaveLength(1);
  });
});

describe('AASd-137 (3.2) — no AAS referable key anywhere in an external reference', () => {
  const env = () =>
    submodel([
      {
        modelType: 'ReferenceElement',
        idShort: 'R',
        value: {
          type: 'ExternalReference',
          keys: [
            { type: 'GlobalReference', value: 'https://example.com/a' },
            { type: 'Property', value: 'P' },
            { type: 'GlobalReference', value: 'https://example.com/b' },
          ],
        },
      },
    ]);

  it('a middle key of type Property is an error in 3.2', () => {
    expect(ids(env(), at('3.2'), L2_RULES, 'AASd-137')).toEqual([
      ['AASd-137', 'error', '/submodels/0/submodelElements/0/value/keys/1/type'],
    ]);
  });

  it('not a constraint before 3.2', () => {
    expect(ids(env(), at('3.1'), L2_RULES, 'AASd-137')).toEqual([]);
  });
});

describe('AASd-138 (3.2) — a list in a template or an operation variable has exactly one element', () => {
  const list = (n: number) => ({
    modelType: 'SubmodelElementList',
    idShort: 'List',
    typeValueListElement: 'Property',
    valueTypeListElement: 'xs:string',
    value: Array.from({ length: n }, () => ({ modelType: 'Property', valueType: 'xs:string' })),
  });

  it('two elements in a Template submodel is an error; one is fine; an Instance submodel is not concerned', () => {
    expect(ids(submodel([list(2)], 'Template'), at('3.2'), L2_RULES, 'AASd-138')).toHaveLength(1);
    expect(ids(submodel([list(1)], 'Template'), at('3.2'), L2_RULES, 'AASd-138')).toEqual([]);
    expect(ids(submodel([list(2)], 'Instance'), at('3.2'), L2_RULES, 'AASd-138')).toEqual([]);
  });

  it('a list inside an operation variable is checked too, in any submodel', () => {
    const env = submodel([{ modelType: 'Operation', idShort: 'Op', inputVariables: [{ value: list(3) }] }], 'Instance');
    expect(ids(env, at('3.2'), L2_RULES, 'AASd-138')).toEqual([
      ['AASd-138', 'error', '/submodels/0/submodelElements/0/inputVariables/0/value'],
    ]);
  });

  it('not a constraint before 3.2', () => {
    expect(ids(submodel([list(2)], 'Template'), at('3.1'), L2_RULES, 'AASd-138')).toEqual([]);
  });
});

describe('AASd-129 — the 3.2 exception for operation variables', () => {
  const env = () =>
    submodel(
      [
        {
          modelType: 'Operation',
          idShort: 'Op',
          inputVariables: [
            {
              value: {
                modelType: 'Property',
                idShort: 'In',
                valueType: 'xs:string',
                qualifiers: [{ kind: 'TemplateQualifier', type: 'Cardinality', valueType: 'xs:string', value: 'One' }],
              },
            },
          ],
        },
      ],
      'Instance',
    );

  it('before 3.2 a template qualifier inside an operation variable of an Instance submodel is an error', () => {
    expect(ids(env(), at('3.1'), L2_RULES, 'AASd-119/129')).toEqual([
      ['AASd-119/129', 'error', '/submodels/0/submodelElements/0/inputVariables/0/value/qualifiers'],
    ]);
  });

  it('3.2 excepts it', () => {
    expect(ids(env(), at('3.2'), L2_RULES, 'AASd-119/129')).toEqual([]);
  });
});

describe('PKG-MM-VERSION — the declared version cannot hold what the file contains', () => {
  const batch = (): Environment =>
    ({
      assetAdministrationShells: [
        {
          modelType: 'AssetAdministrationShell',
          id: 'https://example.com/aas/1',
          idShort: 'Shell',
          assetInformation: { assetKind: 'Batch', globalAssetId: 'https://example.com/asset/1' },
        },
      ],
    }) as unknown as Environment;

  it('declared 3.0 with an AssetKind Batch (3.2) is an error', () => {
    expect(ids(batch(), at('3.0'), ALL_RULES, 'PKG-MM-VERSION')).toEqual([
      ['PKG-MM-VERSION', 'error', '/assetAdministrationShells/0/assetInformation/assetKind'],
    ]);
  });

  it('declared 3.2 holds it; a version guessed from content or no version at all says nothing', () => {
    expect(ids(batch(), at('3.2'), ALL_RULES, 'PKG-MM-VERSION')).toEqual([]);
    expect(ids(batch(), { metamodel: detectMetamodelVersion(batch()) }, ALL_RULES, 'PKG-MM-VERSION')).toEqual([]);
    expect(ids(batch(), {}, ALL_RULES, 'PKG-MM-VERSION')).toEqual([]);
  });

  it('declared 3.1 with createdAt (3.2) is an error', () => {
    const env = submodel([]);
    (env.submodels![0] as unknown as Record<string, unknown>)['administration'] = { version: '1', createdAt: '2026-10-19T00:00:00Z' };
    expect(ids(env, at('3.1'), ALL_RULES, 'PKG-MM-VERSION')).toEqual([
      ['PKG-MM-VERSION', 'error', '/submodels/0/administration/createdAt'],
    ]);
  });

  it('declared 3.0 with an Entity without entityType (optional only from 3.1) is an error', () => {
    const env = submodel([{ modelType: 'Entity', idShort: 'E' }]);
    expect(ids(env, at('3.0'), ALL_RULES, 'PKG-MM-VERSION')).toEqual([
      ['PKG-MM-VERSION', 'error', '/submodels/0/submodelElements/0/entityType'],
    ]);
    expect(ids(env, at('3.1'), ALL_RULES, 'PKG-MM-VERSION')).toEqual([]);
  });
});

describe('a remembered version on a re-read body (source content, inferred false) counts as declared', () => {
  // What the API passes after repacking: the store's version with inferred=false, evidence and fits from the content
  const remembered = (env: Environment, version: MetamodelVersion): LintOptions => ({
    metamodel: { ...detectMetamodelVersion(env), version, inferred: false },
  });

  it('a remembered 3.0 file is held to AASd-120 even though its content would also fit 3.1', () => {
    const env = submodel([
      {
        modelType: 'SubmodelElementList',
        idShort: 'List',
        typeValueListElement: 'Property',
        valueTypeListElement: 'xs:string',
        value: [{ modelType: 'Property', idShort: 'Item', valueType: 'xs:string', value: 'x' }],
      },
    ]);
    expect(detectMetamodelVersion(env).fits).toEqual(['3.0', '3.1', '3.2']);
    expect(ids(env, remembered(env, '3.0'), L2_RULES, 'AASd-120')).toHaveLength(1);
    expect(ids(env, remembered(env, '3.1'), L2_RULES, 'AASd-120')).toEqual([]);
  });

  it('a remembered 3.0 file holding an Entity without entityType is told so by PKG-MM-VERSION', () => {
    const env = submodel([{ modelType: 'Entity', idShort: 'E1' }]);
    expect(ids(env, remembered(env, '3.0'), ALL_RULES, 'PKG-MM-VERSION')).toHaveLength(1);
  });
});

describe('fixing keeps the version', () => {
  it('re-linting inside applyFixes uses the same version — a 3.1 named list child stays untouched', () => {
    const env = submodel([
      {
        modelType: 'SubmodelElementList',
        idShort: 'List',
        typeValueListElement: 'Property',
        valueTypeListElement: 'xs:string',
        value: [{ modelType: 'Property', idShort: 'Item', valueType: 'xs:string', value: 'x' }],
      },
    ]);
    const findings = lint(env, ALL_RULES, at('3.1')).findings;
    const result = applyFixes(env, findings, { includeWarnings: true, ...at('3.1') });
    expect(result.applied.filter((a) => a.ruleId === 'AASd-120')).toEqual([]);
  });
});
