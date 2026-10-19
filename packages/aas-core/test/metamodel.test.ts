/**
 * One check per metamodel difference between V3.0, V3.1 and V3.2 (IDTA-01001 change notes and the official JSON
 * schemas of tags V3.0.9 · v3.1.2 · v3.2.0). Each case is written so the version it needs is known in advance.
 *
 * Important: detection and lowering share one feature table. A difference added to one but not the other shows up
 *    here as "detected as 3.1 but lowered without an entry" (or the reverse).
 */
import {
  ASSET_KINDS,
  ASSET_KINDS_BY_VERSION,
  convertEnvironment,
  DEFAULT_METAMODEL_VERSION,
  DowngradeError,
  detectMetamodelVersion,
  METAMODEL_XML_NAMESPACES,
  writeEnvironment,
  type Environment,
  type MetamodelVersion,
} from '@aas/core';
import { describe, expect, it } from 'vitest';

const shell = (assetInformation: Record<string, unknown>, extra: Record<string, unknown> = {}): Environment =>
  ({
    assetAdministrationShells: [
      { modelType: 'AssetAdministrationShell', id: 'urn:example:aas:1', assetInformation, ...extra },
    ],
  }) as unknown as Environment;

const submodel = (elements: Record<string, unknown>[], extra: Record<string, unknown> = {}): Environment =>
  ({
    submodels: [{ modelType: 'Submodel', id: 'urn:example:sm:1', idShort: 'Example', submodelElements: elements, ...extra }],
  }) as unknown as Environment;

const ref = { type: 'ModelReference', keys: [{ type: 'Submodel', value: 'urn:example:sm:1' }] };
const long = (n: number) => `urn:example:${'x'.repeat(n - 12)}`;

interface Case {
  name: string;
  env: Environment;
  needs: MetamodelVersion;
  /** Lowering to 3.0 must drop (rather than refuse) */
  dropsTo30?: boolean;
}

const CASES: Case[] = [
  { name: 'plain 3.0 shell', env: shell({ assetKind: 'Instance', globalAssetId: 'urn:example:asset:1' }), needs: '3.0' },
  { name: 'AssetKind Role', env: shell({ assetKind: 'Role', globalAssetId: 'urn:example:asset:1' }), needs: '3.1' },
  { name: 'AssetKind Batch', env: shell({ assetKind: 'Batch', globalAssetId: 'urn:example:asset:1' }), needs: '3.2' },
  {
    name: 'administration createdAt',
    env: shell({ assetKind: 'Type', globalAssetId: 'urn:example:asset:1' }, { administration: { createdAt: '2026-01-01T00:00:00Z' } }),
    needs: '3.2',
    dropsTo30: true,
  },
  {
    name: 'administration updatedAt on a submodel',
    env: submodel([], { administration: { version: '1', updatedAt: '2026-01-01T00:00:00Z' } }),
    needs: '3.2',
    dropsTo30: true,
  },
  {
    name: 'DataSpecificationUom content',
    env: {
      conceptDescriptions: [
        {
          modelType: 'ConceptDescription',
          id: 'urn:example:cd:1',
          embeddedDataSpecifications: [
            {
              dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:example:ds:uom' }] },
              dataSpecificationContent: { modelType: 'DataSpecificationUom', preferredName: [{ language: 'en', text: 'metre' }], symbol: 'm' },
            },
          ],
        },
      ],
    } as unknown as Environment,
    needs: '3.2',
    dropsTo30: true,
  },
  { name: 'Entity without entityType', env: submodel([{ modelType: 'Entity', idShort: 'Part' }]), needs: '3.1' },
  {
    name: 'RelationshipElement without second',
    env: submodel([{ modelType: 'RelationshipElement', idShort: 'Link', first: ref }]),
    needs: '3.1',
  },
  {
    name: 'AnnotatedRelationshipElement without first',
    env: submodel([{ modelType: 'AnnotatedRelationshipElement', idShort: 'Link', second: ref }]),
    needs: '3.1',
  },
  { name: 'File without contentType', env: submodel([{ modelType: 'File', idShort: 'Manual' }]), needs: '3.1' },
  { name: 'Blob without contentType', env: submodel([{ modelType: 'Blob', idShort: 'Data' }]), needs: '3.1' },
  {
    name: 'contentType longer than 100',
    env: submodel([{ modelType: 'File', idShort: 'Manual', contentType: `application/${'x'.repeat(100)}` }]),
    needs: '3.1',
  },
  { name: 'idShort with a hyphen', env: submodel([{ modelType: 'Property', idShort: 'Max-Speed', valueType: 'xs:int' }]), needs: '3.1' },
  {
    name: 'nested idShort with a hyphen (inside a collection)',
    env: submodel([
      { modelType: 'SubmodelElementCollection', idShort: 'Group', value: [{ modelType: 'Capability', idShort: 'can-weld' }] },
    ]),
    needs: '3.1',
  },
  {
    name: 'identifier of 2048 characters',
    env: { submodels: [{ modelType: 'Submodel', id: long(2048) }] } as unknown as Environment,
    needs: '3.1',
  },
  { name: 'identifier of exactly 2000 characters', env: { submodels: [{ modelType: 'Submodel', id: long(2000) }] } as unknown as Environment, needs: '3.0' },
  {
    name: 'Key value of 2048 characters',
    env: submodel([{ modelType: 'ReferenceElement', idShort: 'Ref', value: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: long(2048) }] } }]),
    needs: '3.1',
  },
  {
    name: 'ValueReferencePair without valueId',
    env: {
      conceptDescriptions: [
        {
          modelType: 'ConceptDescription',
          id: 'urn:example:cd:2',
          embeddedDataSpecifications: [
            {
              dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:example:ds:iec' }] },
              dataSpecificationContent: {
                modelType: 'DataSpecificationIec61360',
                preferredName: [{ language: 'en', text: 'mode' }],
                valueList: { valueReferencePairs: [{ value: 'auto' }] },
              },
            },
          ],
        },
      ],
    } as unknown as Environment,
    needs: '3.1',
  },
];

describe('detection — the lowest version that can hold the content', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.needs}`, () => {
      const detected = detectMetamodelVersion(c.env);
      expect(detected.version).toBe(c.needs);
      expect(detected.inferred).toBe(true);
      expect(detected.source).toBe('content');
      if (c.needs === '3.0') expect(detected.evidence).toEqual([]);
      else expect(detected.evidence.length).toBeGreaterThan(0);
    });
  }
});

describe('lowering to 3.0', () => {
  for (const c of CASES) {
    it(`${c.name}`, () => {
      const before = JSON.stringify(c.env);
      if (c.needs === '3.0') {
        const { environment, report } = convertEnvironment(c.env, { to: '3.0' });
        expect(report.entries).toEqual([]);
        expect(environment).toBe(c.env); // nothing to do — same object, so the output bytes cannot change
        return;
      }
      if (c.dropsTo30) {
        const { environment, report } = convertEnvironment(c.env, { to: '3.0' });
        expect(report.entries.every((e) => e.kind === 'dropped')).toBe(true);
        expect(report.entries.length).toBeGreaterThan(0);
        expect(detectMetamodelVersion(environment).version).toBe('3.0');
      } else {
        expect(() => convertEnvironment(c.env, { to: '3.0' })).toThrow(DowngradeError);
        const { environment, report } = convertEnvironment(c.env, { to: '3.0', unrepresentable: 'keep' });
        expect(report.entries.length).toBeGreaterThan(0);
        expect(report.entries.every((e) => e.kind === 'unrepresentable' && e.message.length > 0)).toBe(true);
        expect(JSON.stringify(environment)).toBe(before); // kept as is
      }
      expect(JSON.stringify(c.env)).toBe(before); // never mutates the input
    });
  }

  it('to the version the content needs, nothing is reported', () => {
    for (const c of CASES) expect(convertEnvironment(c.env, { to: c.needs }).report.entries, c.name).toEqual([]);
  });

  it('a lowered-away embedded data specification leaves no empty array behind', () => {
    const c = CASES.find((x) => x.name === 'DataSpecificationUom content')!;
    const { environment } = convertEnvironment(c.env, { to: '3.1' });
    expect('embeddedDataSpecifications' in environment.conceptDescriptions![0]!).toBe(false);
  });
});

describe('writeEnvironment', () => {
  it('defaults to 3.0 and refuses what 3.0 cannot hold', () => {
    expect(DEFAULT_METAMODEL_VERSION).toBe('3.0');
    const batch = CASES.find((c) => c.name === 'AssetKind Batch')!.env;
    expect(() => writeEnvironment(batch)).toThrow(DowngradeError);
    const error = (() => {
      try {
        writeEnvironment(batch);
      } catch (e) {
        return e as DowngradeError;
      }
      return undefined;
    })();
    expect(error?.report.target).toBe('3.0');
    expect(writeEnvironment(batch, { version: '3.2' }).text).toContain('"Batch"');
  });
});

describe('version tables', () => {
  it('AssetKind per version follows the official schemas, and the 3.0 list is unchanged', () => {
    expect([...ASSET_KINDS]).toEqual(['Type', 'Instance', 'NotApplicable']);
    expect([...ASSET_KINDS_BY_VERSION['3.0']].sort()).toEqual(['Instance', 'NotApplicable', 'Type']);
    expect([...ASSET_KINDS_BY_VERSION['3.1']].sort()).toEqual(['Instance', 'NotApplicable', 'Role', 'Type']);
    expect([...ASSET_KINDS_BY_VERSION['3.2']].sort()).toEqual(['Batch', 'Instance', 'NotApplicable', 'Role', 'Type']);
  });

  it('XML namespaces', () => {
    expect(METAMODEL_XML_NAMESPACES).toEqual({
      '3.0': 'https://admin-shell.io/aas/3/0',
      '3.1': 'https://admin-shell.io/aas/3/1',
      '3.2': 'https://admin-shell.io/aas/3/2',
    });
  });
});
