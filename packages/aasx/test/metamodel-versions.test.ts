/**
 * AAS metamodel V3.0 · V3.1 · V3.2 — reading every official example, writing in a chosen version.
 *
 * Important: these tests use the IDTA's own generated examples (tests/fixtures/idta-metamodel, see its README), so a
 *    3.1 or 3.2 construct we do not know about shows up here first. "It opened" is not the bar — the XML and the JSON
 *    of the same example must read to the same model, and nothing may disappear without a report entry.
 */
import {
  canonicalJson,
  convertEnvironment,
  DowngradeError,
  detectMetamodelVersion,
  parseEnvironment,
  serializeEnvironment,
  writeEnvironment,
  type Environment,
  type MetamodelVersion,
} from '@aas/core';
import { parseEnvironmentXml, readAasx, writeAasx, writeAasxWithReport, xmlMetamodelVersion } from '@aas/aasx';
import { strToU8, zipSync } from 'fflate';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixture } from './fixtures.js';

const ROOT = 'tests/fixtures/idta-metamodel';
const VERSIONS: MetamodelVersion[] = ['3.0', '3.1', '3.2'];

interface Example {
  name: string;
  json: string;
  xml: string;
}

/** Pairs each JSON example with its XML twin (XML folders use lowerCamel class names) */
function examples(version: MetamodelVersion): Example[] {
  const out: Example[] = [];
  for (const cls of readdirSync(join(ROOT, version, 'json')).sort()) {
    const xmlDir = cls.charAt(0).toLowerCase() + cls.slice(1);
    for (const kind of ['minimal', 'maximal']) {
      out.push({
        name: `${cls}/${kind}`,
        json: readFileSync(join(ROOT, version, 'json', cls, `${kind}.json`), 'utf8'),
        xml: readFileSync(join(ROOT, version, 'xml', xmlDir, `${kind}.xml`), 'utf8'),
      });
    }
  }
  return out;
}

const ALL = Object.fromEntries(VERSIONS.map((v) => [v, examples(v)])) as Record<MetamodelVersion, Example[]>;

/** AASX with the given body part — built by hand so the test does not depend on our own writer */
function aasxWith(part: string, body: string): Uint8Array {
  const rels = (items: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/>' +
        '<Override PartName="/aasx/aasx-origin" ContentType="text/plain"/></Types>',
    ),
    '_rels/.rels': strToU8(
      rels('<Relationship Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin" Id="r1"/>'),
    ),
    'aasx/aasx-origin': new Uint8Array(0),
    'aasx/_rels/aasx-origin.rels': strToU8(
      rels(`<Relationship Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="${part}" Id="r0"/>`),
    ),
    [part.slice(1)]: strToU8(body),
  });
}

describe('official examples — XML and JSON read to the same model', () => {
  for (const version of VERSIONS) {
    it(`V${version}: all ${ALL[version].length} examples match`, () => {
      const mismatched: string[] = [];
      for (const ex of ALL[version]) {
        const fromJson = parseEnvironment(ex.json);
        const fromXml = parseEnvironmentXml(ex.xml);
        if (canonicalJson(fromXml) !== canonicalJson(fromJson)) mismatched.push(ex.name);
      }
      expect(mismatched).toEqual([]);
    });
  }

  it('the XML namespace states the version', () => {
    for (const version of VERSIONS) {
      for (const ex of ALL[version]) expect(xmlMetamodelVersion(ex.xml), ex.name).toBe(version);
    }
    // A prefixed namespace says the same
    expect(xmlMetamodelVersion('<aas:environment xmlns:aas="https://admin-shell.io/aas/3/1"/>')).toBe('3.1');
    expect(xmlMetamodelVersion('<environment/>')).toBeUndefined();
    expect(xmlMetamodelVersion('<environment xmlns="https://admin-shell.io/aas/3/9"/>')).toBeUndefined();
  });
});

describe('official examples — content tells the lowest version that can hold it', () => {
  it('no 3.0 example needs more than 3.0', () => {
    const above = ALL['3.0'].filter((ex) => detectMetamodelVersion(parseEnvironment(ex.json)).version !== '3.0');
    expect(above.map((ex) => ex.name)).toEqual([]);
  });

  it('3.1 and 3.2 constructs are recognised', () => {
    const find = (version: MetamodelVersion, name: string) => {
      const ex = ALL[version].find((e) => e.name === name)!;
      return detectMetamodelVersion(parseEnvironment(ex.json));
    };
    // 3.1: entityType became optional, so the minimal Entity has none
    expect(find('3.1', 'Entity/minimal').version).toBe('3.1');
    // 3.2: createdAt / updatedAt and the UoM data specification
    expect(find('3.2', 'AdministrativeInformation/maximal').version).toBe('3.2');
    expect(find('3.2', 'DataSpecificationUom/minimal').version).toBe('3.2');
    const detected = find('3.2', 'AdministrativeInformation/maximal');
    expect(detected.inferred).toBe(true);
    expect(detected.source).toBe('content');
  });
});

describe('official examples — read → write in the same version loses nothing', () => {
  for (const version of VERSIONS) {
    it(`V${version}`, () => {
      const lossy: string[] = [];
      for (const ex of ALL[version]) {
        const env = parseEnvironment(ex.json);
        const { text, report } = writeEnvironment(env, { version });
        if (report.entries.length > 0 || canonicalJson(parseEnvironment(text)) !== canonicalJson(JSON.parse(ex.json))) {
          lossy.push(ex.name);
        }
      }
      expect(lossy).toEqual([]);
    });
  }
});

describe('default output stays V3.0 byte for byte', () => {
  it('writeEnvironment without a version writes 3.0 examples exactly as serializeEnvironment', () => {
    for (const ex of ALL['3.0']) {
      const env = parseEnvironment(ex.json);
      const { text, report } = writeEnvironment(env);
      expect(report.target).toBe('3.0');
      expect(text, ex.name).toBe(serializeEnvironment(env));
    }
  });

  it('writeAasx bytes do not change for the equipment fixtures — with or without version 3.0', () => {
    for (const name of FIXTURES) {
      const pkg = readAasx(loadFixture(name));
      const plain = writeAasx(pkg);
      expect(writeAasx(pkg, { version: '3.0' })).toEqual(plain);
      const reported = writeAasxWithReport(pkg);
      expect(reported.data).toEqual(plain);
      expect(reported.report.entries).toEqual([]);
    }
  });
});

describe('lowering 3.1 / 3.2 to 3.0 — what is lost is reported, never silent', () => {
  it('every 3.2 example either lowers with a report or is refused with one', () => {
    for (const version of ['3.1', '3.2'] as const) {
      for (const ex of ALL[version]) {
        const env = parseEnvironment(ex.json);
        const needs = detectMetamodelVersion(env).version;
        let result: ReturnType<typeof convertEnvironment> | undefined;
        try {
          result = convertEnvironment(env, { to: '3.0' });
        } catch (error) {
          expect(error, ex.name).toBeInstanceOf(DowngradeError);
          const report = (error as DowngradeError).report;
          expect(report.entries.some((e) => e.kind === 'unrepresentable'), ex.name).toBe(true);
          continue;
        }
        // Lowered: the result fits 3.0, and if anything had to go there is an entry for it
        expect(detectMetamodelVersion(result.environment).version, ex.name).toBe('3.0');
        if (needs !== '3.0') expect(result.report.entries.length, ex.name).toBeGreaterThan(0);
        else expect(result.report.entries, ex.name).toEqual([]);
      }
    }
  });

  it('createdAt / updatedAt are dropped with their values kept in the report', () => {
    const ex = ALL['3.2'].find((e) => e.name === 'AdministrativeInformation/maximal')!;
    const env = parseEnvironment(ex.json);
    // The example also carries assetKind Role (3.1) — keep it so only the 3.2 drops are judged here
    const { environment, report } = convertEnvironment(env, { to: '3.0', unrepresentable: 'keep' });
    const admin = environment.assetAdministrationShells![0]!.administration as Record<string, unknown>;
    expect(admin['createdAt']).toBeUndefined();
    expect(admin['updatedAt']).toBeUndefined();
    const created = report.entries.find((e) => e.pointer === '/assetAdministrationShells/0/administration/createdAt')!;
    expect(created.kind).toBe('dropped');
    expect(created.since).toBe('3.2');
    expect(created.value).toBe('2022-04-01T01:02:03Z');
    // The input is not touched
    expect((env.assetAdministrationShells![0]!.administration as Record<string, unknown>)['createdAt']).toBe(
      '2022-04-01T01:02:03Z',
    );
  });

  it('AssetKind Batch cannot be lowered — refused by default, kept and reported on request', () => {
    const env: Environment = {
      assetAdministrationShells: [
        {
          modelType: 'AssetAdministrationShell',
          id: 'urn:example:aas:batch-1',
          assetInformation: { assetKind: 'Batch', globalAssetId: 'urn:example:asset:batch-1' },
        },
      ],
    };
    expect(() => convertEnvironment(env, { to: '3.1' })).toThrow(DowngradeError);
    const kept = convertEnvironment(env, { to: '3.1', unrepresentable: 'keep' });
    expect(kept.environment.assetAdministrationShells![0]!.assetInformation.assetKind).toBe('Batch');
    expect(kept.report.entries).toEqual([
      expect.objectContaining({
        kind: 'unrepresentable',
        pointer: '/assetAdministrationShells/0/assetInformation/assetKind',
        since: '3.2',
        value: 'Batch',
      }),
    ]);
    // 3.2 itself holds it
    expect(convertEnvironment(env, { to: '3.2' }).report.entries).toEqual([]);
  });

  it('writeAasx with a version refuses to lose data silently', () => {
    const body = ALL['3.2'].find((e) => e.name === 'AdministrativeInformation/maximal')!.json;
    const pkg = readAasx(aasxWith('/aasx/data.json', body));
    expect(() => writeAasx(pkg, { version: '3.0' })).toThrow(DowngradeError);
    const { report } = writeAasxWithReport(pkg, { version: '3.0', unrepresentable: 'keep' });
    expect(report.entries.length).toBeGreaterThan(0);
  });

  it('writeAasx with a version refuses even a pure drop — it cannot hand back the report', () => {
    const env: Environment = {
      submodels: [
        { modelType: 'Submodel', id: 'urn:example:sm:dated', administration: { version: '1', createdAt: '2026-01-01T00:00:00Z' } },
      ],
    };
    const pkg = readAasx(aasxWith('/aasx/data.json', JSON.stringify(env)));
    let caught: unknown;
    try {
      writeAasx(pkg, { version: '3.1', unrepresentable: 'keep' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DowngradeError);
    expect((caught as DowngradeError).reason).toBe('would-drop');
    // With the report it goes through, and the dropped value is in the report
    const { data, report } = writeAasxWithReport(pkg, { version: '3.1' });
    expect(report.entries).toEqual([expect.objectContaining({ kind: 'dropped', value: '2026-01-01T00:00:00Z' })]);
    expect(readAasx(data).environment.submodels![0]!.administration).toEqual({ version: '1' });
    // Without a version, writeAasx keeps writing what it holds — internal round trips must not lose the field
    expect(readAasx(writeAasx(pkg)).environment.submodels![0]!.administration?.createdAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('AASX — the version travels with the read result', () => {
  it('an XML body reports its namespace version', () => {
    const ex = ALL['3.2'].find((e) => e.name === 'DataSpecificationUom/maximal')!;
    const pkg = readAasx(aasxWith('/aasx/data.xml', ex.xml));
    expect(pkg.metamodel).toEqual(expect.objectContaining({ version: '3.2', source: 'namespace', inferred: false }));
    expect(canonicalJson(pkg.environment)).toBe(canonicalJson(JSON.parse(ex.json)));
  });

  it('a JSON body reports an inferred version', () => {
    const ex = ALL['3.1'].find((e) => e.name === 'Entity/minimal')!;
    const pkg = readAasx(aasxWith('/aasx/data.json', ex.json));
    expect(pkg.metamodel).toEqual(expect.objectContaining({ version: '3.1', source: 'content', inferred: true }));
  });

  it('the equipment fixtures read as 3.0', () => {
    for (const name of FIXTURES) expect(readAasx(loadFixture(name)).metamodel.version).toBe('3.0');
  });
});
