/**
 * Every direction between V3.0, V3.1 and V3.2 — output must pass the **official JSON schema of the version written**.
 *
 * Important: "we converted it" is not the bar; the IDTA's own schema accepting the result is. The schemas are the
 *    unchanged files of the tags in tests/fixtures/idta-metamodel/README.md, compiled with ajv (draft 2019-09, no `u`
 *    flag — the schema patterns spell surrogates out as ranges and are meant to be read that way).
 */
import {
  canonicalJson,
  convertEnvironment,
  DowngradeError,
  parseEnvironment,
  writeEnvironment,
  type DowngradeReport,
  type Environment,
  type MetamodelVersion,
} from '@aas/core';
import { readAasx, writeAasx, writeAasxWithReport } from '@aas/aasx';
// Named import: the default export does not survive CommonJS interop under NodeNext type checking
import { Ajv2019, type ValidateFunction } from 'ajv/dist/2019.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixture } from './fixtures.js';

const ROOT = 'tests/fixtures/idta-metamodel';
const VERSIONS: MetamodelVersion[] = ['3.0', '3.1', '3.2'];

const SCHEMA: Record<MetamodelVersion, ValidateFunction> = Object.fromEntries(
  VERSIONS.map((v) => {
    const ajv = new Ajv2019({ strict: false, unicodeRegExp: false, allErrors: true });
    return [v, ajv.compile(JSON.parse(readFileSync(join(ROOT, v, 'aas.schema.json'), 'utf8')) as object)];
  }),
) as Record<MetamodelVersion, ValidateFunction>;

function valid(version: MetamodelVersion, text: string): string | undefined {
  const validate = SCHEMA[version];
  if (validate(JSON.parse(text))) return undefined;
  return (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath} ${e.message ?? ''}`).join(' | ');
}

function examples(version: MetamodelVersion): { name: string; env: Environment }[] {
  const out: { name: string; env: Environment }[] = [];
  for (const cls of readdirSync(join(ROOT, version, 'json')).sort()) {
    for (const kind of ['minimal', 'maximal']) {
      const text = readFileSync(join(ROOT, version, 'json', cls, `${kind}.json`), 'utf8');
      out.push({ name: `${cls}/${kind}`, env: parseEnvironment(text) });
    }
  }
  return out;
}
const ALL = Object.fromEntries(VERSIONS.map((v) => [v, examples(v)])) as Record<MetamodelVersion, ReturnType<typeof examples>>;

/** Puts dropped values back where they were — proves the report holds everything a lowering removed */
function restore(env: Environment, report: DowngradeReport): Environment {
  const copy = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
  for (const entry of report.entries.filter((e) => e.kind === 'dropped')) {
    const segments = entry.pointer.slice(1).split('/');
    const last = segments.pop()!;
    let node: Record<string, unknown> | unknown[] = copy;
    segments.forEach((segment, i) => {
      const container = node as Record<string, unknown>;
      // A dropped array entry may have taken the whole array with it
      if (container[segment] === undefined) container[segment] = /^\d+$/.test(segments[i + 1] ?? last) ? [] : {};
      node = container[segment] as Record<string, unknown>;
    });
    if (Array.isArray(node)) node.splice(Number(last), 0, entry.value);
    else node[last] = entry.value;
  }
  return copy as Environment;
}

describe('the schema check itself', () => {
  it('rejects what it should (positive control) — a 3.2 value against 3.0 and 3.1', () => {
    const batch = JSON.stringify({
      assetAdministrationShells: [
        { modelType: 'AssetAdministrationShell', id: 'urn:example:aas:1', assetInformation: { assetKind: 'Batch', globalAssetId: 'urn:example:a' } },
      ],
    });
    expect(valid('3.0', batch)).toBeDefined();
    expect(valid('3.1', batch)).toBeDefined();
    expect(valid('3.2', batch)).toBeUndefined();
  });

  it('accepts every official example in its own version', () => {
    for (const v of VERSIONS) {
      const failed = ALL[v].filter((ex) => valid(v, JSON.stringify(ex.env)) !== undefined).map((ex) => ex.name);
      expect(failed, `V${v}`).toEqual([]);
    }
  });
});

describe('every direction — written output passes the target schema, or the write is refused with a reason', () => {
  for (const from of VERSIONS) {
    for (const to of VERSIONS) {
      it(`V${from} → V${to}`, () => {
        const invalid: string[] = [];
        let refused = 0;
        for (const ex of ALL[from]) {
          let text: string;
          try {
            text = writeEnvironment(ex.env, { version: to }).text;
          } catch (error) {
            expect(error, ex.name).toBeInstanceOf(DowngradeError);
            expect((error as DowngradeError).report.entries.some((e) => e.kind === 'unrepresentable'), ex.name).toBe(true);
            refused += 1;
            continue;
          }
          const problem = valid(to, text);
          if (problem) invalid.push(`${ex.name}: ${problem}`);
        }
        expect(invalid).toEqual([]);
        // Raising and staying never refuse an official example — only lowering can meet a value the target lacks
        if (VERSIONS.indexOf(to) >= VERSIONS.indexOf(from)) expect(refused).toBe(0);
      });
    }
  }
});

describe('round trips between versions', () => {
  for (const a of VERSIONS) {
    for (const b of VERSIONS) {
      if (a === b) continue;
      it(`V${a} → V${b} → V${a}`, () => {
        const broken: string[] = [];
        for (const ex of ALL[a]) {
          let there: ReturnType<typeof convertEnvironment>;
          try {
            there = convertEnvironment(ex.env, { to: b });
          } catch (error) {
            expect(error, ex.name).toBeInstanceOf(DowngradeError);
            continue; // refused on the way out — nothing written, nothing lost
          }
          const back = convertEnvironment(parseEnvironment(writeEnvironment(there.environment, { version: b }).text), { to: a });
          expect(back.report.entries, ex.name).toEqual([]); // coming back up (or down to where it started) costs nothing
          // What went out and came back plus what the report kept is exactly the original
          if (canonicalJson(restore(back.environment, there.report)) !== canonicalJson(ex.env)) broken.push(ex.name);
          if (VERSIONS.indexOf(b) > VERSIONS.indexOf(a) && canonicalJson(back.environment) !== canonicalJson(ex.env)) {
            broken.push(`${ex.name} (raising changed content)`);
          }
        }
        expect(broken).toEqual([]);
      });
    }
  }
});

describe('the 3.0-only values the converter refuses are exactly what the newer schemas reject', () => {
  const sm = (element: Record<string, unknown>): Environment =>
    ({ submodels: [{ modelType: 'Submodel', id: 'urn:example:sm:1', submodelElements: [element] }] }) as unknown as Environment;
  const cases: [string, Environment][] = [
    ['one-character idShort', sm({ modelType: 'Property', idShort: 'a', valueType: 'xs:string' })],
    ['File value with Korean letters', sm({ modelType: 'File', idShort: 'Manual', contentType: 'application/pdf', value: '/aasx/설명서.pdf' })],
    ['File value with a space', sm({ modelType: 'File', idShort: 'Manual', contentType: 'application/pdf', value: '/aasx/my manual.pdf' })],
    ['control character in a Range bound', sm({ modelType: 'Range', idShort: 'Band', valueType: 'xs:string', min: 'a\u0001' })],
  ];
  for (const [name, env] of cases) {
    it(name, () => {
      const text = JSON.stringify(env);
      expect(valid('3.0', text)).toBeUndefined();
      for (const to of ['3.1', '3.2'] as const) {
        expect(valid(to, text), `${to} schema`).toBeDefined();
        expect(() => writeEnvironment(env, { version: to }), `${to} write`).toThrow(DowngradeError);
      }
    });
  }
});

describe('equipment fixtures in every version', () => {
  it('write as 3.1 and 3.2 without loss, pass those schemas, and come back to the same 3.0 bytes', () => {
    for (const name of FIXTURES) {
      const pkg = readAasx(loadFixture(name));
      const original = writeAasx(pkg);
      for (const version of ['3.1', '3.2'] as const) {
        const { data, report } = writeAasxWithReport(pkg, { version });
        expect(report.lossless, `${name} ${version}`).toBe(true);
        const again = readAasx(data);
        expect(valid(version, JSON.stringify(again.environment)), `${name} ${version}`).toBeUndefined();
        expect(writeAasx(again, { version: '3.0' }), `${name} ${version} → 3.0`).toEqual(original);
      }
    }
  });
});
