/**
 * An XML list wrapper written with no items (`<qualifiers />`) is an empty list.
 *
 * Important: it used to be read as the empty string. The linter then threw (`''.some is not a function`) and the
 *    JSON we wrote could not be read back — measured on 61 of the 179 public KOSMO reference models (2026-10-20).
 *    The body below is our own; those files carry no license and are not copied into this repository.
 */
import { parseEnvironmentXml, readAasx, writeAasx, XML_LIST_FIELDS } from '@aas/aasx';
import { ALL_RULES, lint } from '@aas/linter';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BODY = `<?xml version="1.0" encoding="utf-8"?>
<environment xmlns="https://admin-shell.io/aas/3/0">
  <assetAdministrationShells>
    <assetAdministrationShell>
      <idShort>Machine</idShort>
      <description />
      <id>https://example.com/aas/1</id>
      <assetInformation>
        <assetKind>Type</assetKind>
        <globalAssetId>https://example.com/asset/1</globalAssetId>
        <specificAssetIds />
      </assetInformation>
      <submodels>
        <reference>
          <type>ModelReference</type>
          <keys>
            <key><type>Submodel</type><value>https://example.com/sm/1</value></key>
          </keys>
        </reference>
      </submodels>
    </assetAdministrationShell>
  </assetAdministrationShells>
  <submodels>
    <submodel>
      <idShort>Operation</idShort>
      <description />
      <embeddedDataSpecifications />
      <id>https://example.com/sm/1</id>
      <kind>Instance</kind>
      <supplementalSemanticIds />
      <qualifiers />
      <submodelElements>
        <property>
          <idShort>Speed</idShort>
          <displayName />
          <qualifiers />
          <valueType>xs:double</valueType>
          <value />
          <valueId>
            <type>ExternalReference</type>
            <keys />
          </valueId>
        </property>
        <submodelElementCollection>
          <idShort>Empty</idShort>
          <value />
        </submodelElementCollection>
        <multiLanguageProperty>
          <idShort>Note</idShort>
          <value />
        </multiLanguageProperty>
        <entity>
          <idShort>Part</idShort>
          <statements />
          <entityType>CoManagedEntity</entityType>
        </entity>
      </submodelElements>
    </submodel>
  </submodels>
  <conceptDescriptions>
    <conceptDescription>
      <idShort>Speed</idShort>
      <id>https://example.com/cd/1</id>
      <isCaseOf />
      <embeddedDataSpecifications>
        <embeddedDataSpecification>
          <dataSpecification>
            <type>ExternalReference</type>
            <keys>
              <key><type>GlobalReference</type><value>https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIEC61360/3/0</value></key>
            </keys>
          </dataSpecification>
          <dataSpecificationContent>
            <dataSpecificationIec61360>
              <preferredName>
                <langStringPreferredNameTypeIec61360><language>en</language><text>Speed</text></langStringPreferredNameTypeIec61360>
              </preferredName>
              <shortName />
              <unit></unit>
              <valueList>
                <valueReferencePairs />
              </valueList>
            </dataSpecificationIec61360>
          </dataSpecificationContent>
        </embeddedDataSpecification>
      </embeddedDataSpecifications>
    </conceptDescription>
  </conceptDescriptions>
</environment>`;

/** Our XML fixture package with its body replaced by BODY */
function packageWith(body: string): Uint8Array {
  const parts = unzipSync(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine-xml.aasx')));
  parts['aasx/data.xml'] = strToU8(body);
  return zipSync(parts);
}

/** Every field holding something other than an array where the metamodel has one */
function nonArrays(value: unknown, pointer = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => nonArrays(v, `${pointer}/${i}`));
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  const listValue = ['SubmodelElementCollection', 'SubmodelElementList', 'MultiLanguageProperty'].includes(String(node['modelType']));
  return Object.entries(node).flatMap(([k, v]) => {
    const isList = k === 'value' ? listValue : XML_LIST_FIELDS.has(k);
    return [...(isList && !Array.isArray(v) ? [`${pointer}/${k}`] : []), ...nonArrays(v, `${pointer}/${k}`)];
  });
}

describe('empty XML list wrappers', () => {
  const env = parseEnvironmentXml(BODY);
  const sm = env.submodels![0]!;
  const [speed, empty, note, part] = sm.submodelElements! as unknown as Record<string, unknown>[];

  it('read as empty arrays, never as the empty string', () => {
    expect(nonArrays(env)).toEqual([]);
    expect(sm.qualifiers).toEqual([]);
    expect(sm.description).toEqual([]);
    expect(env.assetAdministrationShells![0]!.assetInformation.specificAssetIds).toEqual([]);
    expect(speed!['qualifiers']).toEqual([]);
    expect((speed!['valueId'] as { keys: unknown }).keys).toEqual([]);
    expect(empty!['value']).toEqual([]);
    expect(note!['value']).toEqual([]);
    expect(part!['statements']).toEqual([]);
    expect(env.conceptDescriptions![0]!.isCaseOf).toEqual([]);
  });

  it('leaves empty text fields as text — Property value, unit', () => {
    expect(speed!['value']).toBe('');
    const content = env.conceptDescriptions![0]!.embeddedDataSpecifications![0]!.dataSpecificationContent as unknown as Record<string, unknown>;
    expect(content['unit']).toBe('');
    expect(content['shortName']).toEqual([]);
    expect((content['valueList'] as { valueReferencePairs: unknown }).valueReferencePairs).toEqual([]);
  });

  it('lints without throwing', () => {
    const pkg = readAasx(packageWith(BODY));
    const result = lint(pkg.environment, ALL_RULES, { package: pkg.opc, metamodel: pkg.metamodel });
    expect(result.rulesRun).toBe(ALL_RULES.length);
    // The empty lists are reported as such instead of crashing a rule
    expect(result.countByRule['PKG-EMPTY-ARRAY'] ?? 0).toBeGreaterThan(0);
  });

  it('round-trips, and the saved copy opens again unchanged', () => {
    const pkg = readAasx(packageWith(BODY));
    const saved = writeAasx(pkg);
    const again = readAasx(saved);
    expect(again.environment).toEqual(pkg.environment);
    expect(readAasx(writeAasx(again)).environment).toEqual(pkg.environment);
  });
});

describe('XML_LIST_FIELDS', () => {
  it('is exactly the array properties of the official 3.0 · 3.1 · 3.2 JSON schemas (value aside)', () => {
    const fromSchemas = new Set<string>();
    for (const version of ['3.0', '3.1', '3.2']) {
      const schema = JSON.parse(readFileSync(join('tests/fixtures/idta-metamodel', version, 'aas.schema.json'), 'utf8')) as {
        $defs?: Record<string, unknown>;
        definitions?: Record<string, unknown>;
      };
      for (const def of Object.values(schema.$defs ?? schema.definitions ?? {}) as { properties?: object; allOf?: { properties?: object }[] }[]) {
        for (const part of [def, ...(def.allOf ?? [])]) {
          for (const [name, prop] of Object.entries(part.properties ?? {}) as [string, { type?: string }][]) {
            if (prop.type === 'array' && name !== 'value') fromSchemas.add(name);
          }
        }
      }
    }
    expect([...XML_LIST_FIELDS].sort()).toEqual([...fromSchemas].sort());
  });
});
