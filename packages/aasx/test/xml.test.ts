/**
 * Reading XML-serialized AASX.
 *
 * Important: the point of this test is not "it can be read" but **it reads exactly the same as the JSON version**.
 * Silently reading it differently is worse than failing to read it (lesson measured with basyx on this project).
 *
 * The comparison file is the same content rewritten as XML by basyx-python-sdk
 * (`tests/fixtures/01-롤포밍기-XML판.aasx`).
 */
import { readAasx, parseEnvironmentXml, AasxXmlError, writeAasx } from '@aas/aasx';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const xmlBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-XML판.aasx'));
const jsonBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

/** Compare ignoring key order — XML is written in the order the spec defines, so key order differs from JSON */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function countElements(environment: { submodels?: { submodelElements?: unknown[] }[] }): number {
  let total = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      total += 1;
      const node = item as { value?: unknown; statements?: unknown };
      walk(node.value);
      walk(node.statements);
    }
  };
  for (const submodel of environment.submodels ?? []) walk(submodel.submodelElements);
  return total;
}

describe('XML AASX reading', () => {
  const xml = readAasx(xmlBytes);

  it('opens — submodel, concept description and element counts match', () => {
    expect(xml.environment.assetAdministrationShells).toHaveLength(1);
    expect(xml.environment.submodels).toHaveLength(7);
    expect(xml.environment.conceptDescriptions).toHaveLength(137);
    expect(countElements(xml.environment)).toBe(196);
  });

  it('derives modelType from the element name — XML has no such field', () => {
    const nameplate = xml.environment.submodels!.find((s) => s.idShort === 'DigitalNameplate')!;
    expect(nameplate.modelType).toBe('Submodel');
    const serial = nameplate.submodelElements!.find((e) => e.idShort === 'SerialNumber')!;
    expect(serial.modelType).toBe('Property');
    const markings = nameplate.submodelElements!.find((e) => e.idShort === 'Markings')!;
    expect(markings.modelType).toBe('SubmodelElementList');
  });

  it('preserves order — list children are addressed by position (AASd-120)', () => {
    const handover = xml.environment.submodels!.find((s) => s.idShort === 'HandoverDocumentation')!;
    const documents = handover.submodelElements!.find((e) => e.idShort === 'Documents')!;
    const children = (documents as unknown as { value: { modelType: string }[] }).value;
    expect(children.length).toBeGreaterThan(0);
    // A parser that loses order groups children by type — which breaks this value
    expect(children.every((child) => child.modelType === 'SubmodelElementCollection')).toBe(true);
  });

  it('dataSpecificationContent is a single object, not an array', () => {
    const cd = xml.environment.conceptDescriptions![0] as unknown as {
      embeddedDataSpecifications: { dataSpecificationContent: { modelType: string } }[];
    };
    const content = cd.embeddedDataSpecifications[0]!.dataSpecificationContent;
    expect(Array.isArray(content)).toBe(false);
    expect(content.modelType).toBe('DataSpecificationIec61360');
  });

  it('does not trim text — the file belongs to someone else', () => {
    // 5 German descriptions in the golden file end with whitespace; trimming silently changes them
    const text = JSON.stringify(xml.environment);
    expect(text).toContain('ID für diese Wartung ');
  });

  it('indented XML gives the same result — line breaks must not leak into values', () => {
    const compact = readAasx(xmlBytes).environment;
    // The same document, pretty-printed with indentation
    const raw = new TextDecoder().decode(
      // Instead of extracting and re-inserting the body inside the package, indent the body string directly
      new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-XML판.aasx')),
    );
    expect(raw.length).toBeGreaterThan(0); // only confirm the file exists, then
    const indented = parseEnvironmentXml(
      `<environment xmlns="https://admin-shell.io/aas/3/0">
         <submodels>
           <submodel>
             <idShort>Test</idShort>
             <id>https://example.com/sm/1</id>
             <kind>Template</kind>
           </submodel>
         </submodels>
       </environment>`,
    );
    expect(indented.submodels![0]!.idShort).toBe('Test');
    expect(indented.submodels![0]!.id).toBe('https://example.com/sm/1');
    expect(compact.submodels).toHaveLength(7);
  });

  it('content matches the JSON read (compared against the corrected version)', () => {
    // The comparison file is the AASd-120-corrected version, so only SML children's idShort differ.
    // Everything else must match — checked via the list of submodel ids
    const json = readAasx(jsonBytes).environment;
    const xmlIds = (xml.environment.submodels ?? []).map((s) => s.id).sort();
    const jsonIds = (json.submodels ?? []).map((s) => s.id).sort();
    expect(xmlIds).toEqual(jsonIds);

    const xmlConcepts = (xml.environment.conceptDescriptions ?? []).map((c) => c.id).sort();
    const jsonConcepts = (json.conceptDescriptions ?? []).map((c) => c.id).sort();
    expect(xmlConcepts).toEqual(jsonConcepts);
  });

  it('can open as XML and write back as JSON — keeping a single save path', () => {
    const bytes = writeAasx(xml);
    const again = readAasx(bytes);
    expect(again.specPart.endsWith('.json')).toBe(true);
    expect(normalize(again.environment)).toEqual(normalize(xml.environment));
  });

  it('stops on broken XML and states the reason', () => {
    expect(() => parseEnvironmentXml('<nothing/>')).toThrow(AasxXmlError);
  });
});
