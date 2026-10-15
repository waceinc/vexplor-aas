/**
 * Hostile structure inside an AASX must end as a clean read error, never as a crash or a 500 (red-team L7 / L8, 2026-10-16).
 *
 *   L7 — element nesting thousands deep overflowed the recursive checks (RangeError: Maximum call stack size exceeded)
 *   L8 — a broken [Content_Types].xml or .rels escaped as a raw parser error instead of AasxReadError
 */
import { AasxReadError, readAasx } from '@aas/aasx';
import { jsonDepthExceeds, MAX_ELEMENT_DEPTH, parseEnvironment } from '@aas/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = new Uint8Array(readFileSync(root + '01-roll-forming-machine.aasx'));

/** The golden package with some parts replaced */
function withParts(replace: Record<string, string>): Uint8Array {
  const entries = unzipSync(golden);
  for (const [name, text] of Object.entries(replace)) entries[name] = strToU8(text);
  return zipSync(entries);
}

/**
 * Built as text on purpose. Important: JSON.stringify of a deeply nested object is itself recursive and overflows on
 *    Node 22 / Linux before the code under test even runs — that is how the first version of this test failed in CI.
 */
function nestedJson(depth: number): string {
  const leaf = '{"modelType":"Property","idShort":"leaf","valueType":"xs:string","value":"x"}';
  const open = '{"modelType":"SubmodelElementCollection","idShort":"c","value":['.repeat(depth);
  const close = ']}'.repeat(depth);
  return `{"submodels":[{"modelType":"Submodel","id":"urn:x","idShort":"s","submodelElements":[${open}${leaf}${close}]}]}`;
}

function nestedXml(depth: number): string {
  const open = '<submodelElementCollection><idShort>c</idShort><value>'.repeat(depth);
  const close = '</value></submodelElementCollection>'.repeat(depth);
  return (
    '<environment xmlns="https://admin-shell.io/aas/3/0"><submodels><submodel><id>urn:x</id><idShort>s</idShort>' +
    `<submodelElements>${open}${close}</submodelElements></submodel></submodels></environment>`
  );
}

describe('L7 — the depth scan runs without recursion', () => {
  it('counts brackets outside strings only, honouring escapes', () => {
    expect(jsonDepthExceeds('[[[]]]', 3)).toBe(false);
    expect(jsonDepthExceeds('[[[[]]]]', 3)).toBe(true);
    expect(jsonDepthExceeds('["[[[[[[", {"a": "]]]{{{"}]', 2)).toBe(false);
    expect(jsonDepthExceeds('["\\"[[[[", [[]]]', 2)).toBe(true);
    expect(jsonDepthExceeds('["a\\\\", [[[]]]]', 3)).toBe(true);
  });

  it('handles a million levels in one pass', () => {
    expect(jsonDepthExceeds('['.repeat(1_000_000) + ']'.repeat(1_000_000), 1000)).toBe(true);
  });
});

describe('L7 — nesting depth cap', () => {
  it('parseEnvironment refuses elements nested past the cap with a parse issue, not a stack overflow', () => {
    expect(() => parseEnvironment(nestedJson(MAX_ELEMENT_DEPTH + 1))).toThrow(/깊/);
    expect(() => parseEnvironment(nestedJson(50_000))).not.toThrow(RangeError);
    // Realistic nesting is untouched
    expect(() => parseEnvironment(nestedJson(MAX_ELEMENT_DEPTH - 1))).not.toThrow();
  });

  it('an AASX whose JSON body nests 50 000 deep is an AasxReadError', () => {
    const data = withParts({ 'aasx/data.json': nestedJson(50_000) });
    expect(() => readAasx(data)).toThrow(AasxReadError);
  });

  it('an AASX whose XML body nests 20 000 deep is an AasxReadError', () => {
    const entries = unzipSync(golden);
    const types = strFromU8(entries['[Content_Types].xml']!).replace('/aasx/data.json', '/aasx/data.xml');
    const originRels = strFromU8(entries['aasx/_rels/aasx-origin.rels']!).replace('/aasx/data.json', '/aasx/data.xml');
    const rels = strFromU8(entries['aasx/_rels/data.json.rels']!);
    delete entries['aasx/data.json'];
    delete entries['aasx/_rels/data.json.rels'];
    entries['aasx/data.xml'] = strToU8(nestedXml(20_000));
    entries['aasx/_rels/data.xml.rels'] = strToU8(rels);
    entries['[Content_Types].xml'] = strToU8(types);
    entries['aasx/_rels/aasx-origin.rels'] = strToU8(originRels);
    expect(() => readAasx(zipSync(entries))).toThrow(AasxReadError);
  });

  it('a JSON body that is not valid JSON is an AasxReadError too', () => {
    expect(() => readAasx(withParts({ 'aasx/data.json': '{"submodels": [' }))).toThrow(AasxReadError);
  });
});

describe('L8 — broken package metadata', () => {
  it('a [Content_Types].xml that is not XML is an AasxReadError', () => {
    expect(() => readAasx(withParts({ '[Content_Types].xml': '<Types><Default' }))).toThrow(AasxReadError);
  });

  it('a .rels file that is not XML is an AasxReadError', () => {
    expect(() => readAasx(withParts({ '_rels/.rels': '<Relationships><Relationship Id="x" ' }))).toThrow(AasxReadError);
  });
});
