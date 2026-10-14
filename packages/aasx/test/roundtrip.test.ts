/**
 * M2 acceptance criterion — plan document Phase 2:
 *   "0 Validator errors after loading the existing roll-forming machine AASX and saving it again"
 *
 * This verifies the lossless round trip that criterion depends on.
 * In particular it checks by count that our implementation does not reintroduce the
 * defect measured in linter spec §6-1 (basyx silently dropped submodels from 7 to 5).
 */
import { canonicalJson, collectElements, type Environment } from '@aas/core';
import { readAasx, writeAasx, parseContentTypes, parseRelationships, REL_TYPE } from '@aas/aasx';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FIXTURES, GOLDEN, loadFixture } from './fixtures.js';

/** Extract data.json straight from the original ZIP — a baseline that bypasses our reader */
function rawEnvironment(buffer: Uint8Array): Environment {
  const entries = unzipSync(buffer);
  const raw = entries['aasx/data.json'];
  if (!raw) throw new Error('aasx/data.json이 없습니다.');
  return JSON.parse(strFromU8(raw)) as Environment;
}

describe('AASX reading', () => {
  it('loses none of the golden file submodels or CDs', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(pkg.environment.assetAdministrationShells).toHaveLength(1);
    expect(pkg.environment.submodels).toHaveLength(7); // basyx drops this to 5
    expect(pkg.environment.conceptDescriptions).toHaveLength(137);
    expect(pkg.warnings).toEqual([]);
  });

  it('can traverse every element, including SML subtrees', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const elements = collectElements(pkg.environment);
    const byType = new Map<string, number>();
    for (const e of elements) byType.set(e.node.modelType, (byType.get(e.node.modelType) ?? 0) + 1);

    // Measured distribution (from parsing aasx/data.json directly)
    expect(byType.get('Property')).toBe(84);
    expect(byType.get('SubmodelElementCollection')).toBe(45);
    expect(byType.get('MultiLanguageProperty')).toBe(21);
    expect(byType.get('SubmodelElementList')).toBe(9);
    expect(byType.get('Entity')).toBe(6);
    expect(byType.get('RelationshipElement')).toBe(5);
    expect(byType.get('ReferenceElement')).toBe(3);
    expect(byType.get('File')).toBe(2);
  });

  it('finds the thumbnail part from the relationships', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(pkg.thumbnail).toBeDefined();
    expect(pkg.thumbnail?.part).toBe('/thumbnail.png');
    expect(pkg.thumbnail?.contentType).toBe('image/png');
    expect(pkg.thumbnail?.data.byteLength).toBeGreaterThan(0);
  });

  it('builds paths in the same format as the KOSMO report', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const elements = collectElements(pkg.environment);
    const first = elements[0];
    expect(first).toBeDefined();
    expect(first?.pointer).toMatch(/^\/submodels\/\d+\/submodelElements\/\d+/);
    // e.g. /submodels/3(OperationalData)/submodelElements/0(...)
    expect(first?.kosmoPath).toMatch(/^\/submodels\/\d+\([^)]+\)\/submodelElements\/\d+/);
  });
});

describe('AASX round trip (read → write → read)', () => {
  for (const name of FIXTURES) {
    it(`${name} — Environment is semantically identical`, () => {
      const original = loadFixture(name);
      const pkg = readAasx(original);
      const rewritten = writeAasx(pkg);
      const reread = readAasx(rewritten);

      expect(canonicalJson(reread.environment)).toBe(canonicalJson(pkg.environment));
      expect(reread.warnings).toEqual([]);
    });

    it(`${name} — also semantically identical to the original data.json`, () => {
      const original = loadFixture(name);
      const reread = readAasx(writeAasx(readAasx(original)));
      expect(canonicalJson(reread.environment)).toBe(canonicalJson(rawEnvironment(original)));
    });

    it(`${name} — thumbnail and attachments are preserved byte for byte`, () => {
      const pkg = readAasx(loadFixture(name));
      const reread = readAasx(writeAasx(pkg));

      expect(reread.thumbnail?.data).toEqual(pkg.thumbnail?.data);
      expect(reread.supplementaryFiles.map((f) => f.part))
        .toEqual(pkg.supplementaryFiles.map((f) => f.part));
      for (const [i, f] of reread.supplementaryFiles.entries()) {
        expect(f.data).toEqual(pkg.supplementaryFiles[i]?.data);
      }
    });
  }

  it('output is deterministic (same input → identical bytes)', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    expect(writeAasx(pkg)).toEqual(writeAasx(pkg));
  });
});

describe('OPC package structure (PKG-THUMB-PART)', () => {
  it('parts, relationships and Content_Types are all consistent', () => {
    const pkg = readAasx(loadFixture(GOLDEN));
    const entries = unzipSync(writeAasx(pkg));
    const partNames = new Set(Object.keys(entries).map((n) => `/${n}`));

    // (1) Required parts exist
    for (const p of ['/[Content_Types].xml', '/_rels/.rels', '/aasx/aasx-origin', '/aasx/data.json']) {
      expect(partNames.has(p), `파트 누락: ${p}`).toBe(true);
    }

    // (2) Relationship declarations
    const rootRels = parseRelationships(strFromU8(entries['_rels/.rels']!), '/');
    expect(rootRels.find((r) => r.type === REL_TYPE.origin)?.target).toBe('/aasx/aasx-origin');
    expect(rootRels.find((r) => r.type === REL_TYPE.thumbnail)?.target).toBe('/thumbnail.png');

    const originRels = parseRelationships(strFromU8(entries['aasx/_rels/aasx-origin.rels']!), '/aasx');
    expect(originRels.find((r) => r.type === REL_TYPE.spec)?.target).toBe('/aasx/data.json');

    // (3) Content_Types Override — every declared part must actually exist
    const ct = parseContentTypes(strFromU8(entries['[Content_Types].xml']!));
    expect(ct.overrides.get('/aasx/data.json')).toBe('application/json');
    expect(ct.overrides.get('/thumbnail.png')).toBe('image/png');
    for (const part of ct.overrides.keys()) {
      expect(partNames.has(part), `Override는 있으나 파트가 없음: ${part}`).toBe(true);
    }
    // Reverse direction — every part must be declared in Content_Types
    for (const part of partNames) {
      if (part === '/[Content_Types].xml') continue;
      expect(ct.overrides.has(part), `파트는 있으나 Override가 없음: ${part}`).toBe(true);
    }
  });
});
