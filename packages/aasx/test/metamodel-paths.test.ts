/**
 * Attachment names with spaces or Korean letters, written as V3.1 / V3.2 (2026-10-19).
 *
 * V3.0 takes such a File/value as it is; the V3.1 / V3.2 schemas take only a URI. KOSMO asks for V3.1 and Korean file
 * names are common, so writing 3.1 percent-encodes the value **and** renames the part it points to — a value that
 * points to nothing would fail KOSMO-AAS-1 and every viewer that opens the attachment.
 */
import { DowngradeError, getAtPointer, type Environment, type MetamodelVersion } from '@aas/core';
import { decodeUriPath, encodePackagePaths, encodeUriPath, readAasx, writeAasx, writeAasxWithReport, type AasxPackage } from '@aas/aasx';
// Named import: the default export does not survive CommonJS interop under NodeNext type checking
import { Ajv2019, type ValidateFunction } from 'ajv/dist/2019.js';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN, loadFixture } from './fixtures.js';

const SCHEMA_ROOT = 'tests/fixtures/idta-metamodel';
function schema(version: MetamodelVersion): ValidateFunction {
  const ajv = new Ajv2019({ strict: false, unicodeRegExp: false, allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(join(SCHEMA_ROOT, version, 'aas.schema.json'), 'utf8')) as object);
}

const MANUAL = 'file:///설치 설명서 V1.0.pdf';
const MANUAL_PART = '/설치 설명서 V1.0.pdf';
const PHOTO = '/대표 사진.png';
const FILE_POINTER = '/submodels/1/submodelElements/0/value/0/value/2/value/0/value/6/value/0';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** The golden file with a Korean-named attachment and thumbnail — both referenced from the model */
function koreanNames(): AasxPackage {
  const pkg = readAasx(loadFixture(GOLDEN));
  const environment = JSON.parse(JSON.stringify(pkg.environment)) as Environment;
  const file = getAtPointer(environment, FILE_POINTER) as Record<string, unknown>;
  expect(file['modelType']).toBe('File');
  file['value'] = MANUAL;
  const shell = environment.assetAdministrationShells![0]!;
  shell.assetInformation.defaultThumbnail = { path: PHOTO, contentType: 'image/png' };
  return {
    ...pkg,
    environment,
    thumbnail: { ...pkg.thumbnail!, part: PHOTO },
    supplementaryFiles: [{ part: MANUAL_PART, contentType: 'application/pdf', data: PDF }],
  };
}

function entries(data: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(data);
}

describe('encodeUriPath · decodeUriPath', () => {
  it('encodes spaces, Korean letters and a lone % as UTF-8 escapes; keeps URI characters and existing escapes', () => {
    expect(encodeUriPath('/aasx/files/설명서 1.pdf')).toBe('/aasx/files/%EC%84%A4%EB%AA%85%EC%84%9C%201.pdf');
    expect(encodeUriPath('file:///a b.pdf')).toBe('file:///a%20b.pdf');
    expect(encodeUriPath('/x/100%.pdf')).toBe('/x/100%25.pdf');
    expect(encodeUriPath('/x/a%20b.pdf')).toBe('/x/a%20b.pdf');
    expect(encodeUriPath('/aasx/files/x_1-(2).pdf')).toBe('/aasx/files/x_1-(2).pdf');
    // Encoding twice changes nothing
    const once = encodeUriPath('/설명서 1.pdf');
    expect(encodeUriPath(once)).toBe(once);
  });

  it('decoding gives back the name a person wrote; a broken escape is shown as it is', () => {
    expect(decodeUriPath(encodeUriPath(MANUAL))).toBe(MANUAL);
    expect(decodeUriPath('/x/%E0%A4%A.pdf')).toBe('/x/%E0%A4%A.pdf');
    expect(decodeUriPath('/plain.pdf')).toBe('/plain.pdf');
  });
});

describe('V3.1 / V3.2 with Korean and space file names', () => {
  it('without encoding, writing 3.1 refuses the path — the core never writes a value the schema rejects', () => {
    expect(() => writeAasxWithReport(koreanNames(), { version: '3.1' })).toThrow(DowngradeError);
  });

  for (const version of ['3.1', '3.2'] as const) {
    it(`V${version} — value, part, relationship and Content_Types agree on the encoded name, and the body passes the V${version} schema`, () => {
      const { data, report, renamed } = writeAasxWithReport(koreanNames(), { version, encodePaths: true });
      expect(report.entries).toEqual([]);
      expect(renamed.map((r) => [r.from, r.part?.from])).toEqual([
        [PHOTO, PHOTO],
        [MANUAL, MANUAL_PART],
      ]);

      const zip = entries(data);
      const manualPart = '/%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C%20V1.0.pdf';
      const photoPart = '/%EB%8C%80%ED%91%9C%20%EC%82%AC%EC%A7%84.png';
      expect(zip[manualPart.slice(1)]).toEqual(PDF);
      expect(zip[photoPart.slice(1)]).toBeDefined();
      expect(Object.keys(zip).some((name) => /[^\x21-\x7e]/.test(name))).toBe(false);
      expect(strFromU8(zip['aasx/_rels/data.json.rels']!)).toContain(`Target="${manualPart}"`);
      expect(strFromU8(zip['_rels/.rels']!)).toContain(`Target="${photoPart}"`);
      expect(strFromU8(zip['[Content_Types].xml']!)).toContain(`PartName="${manualPart}"`);

      const body = strFromU8(zip['aasx/data.json']!);
      const validate = schema(version);
      expect(validate(JSON.parse(body)), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);

      // Read back: the reference still finds its part, and the name shown to a person is the original one
      const reread = readAasx(data);
      const value = (getAtPointer(reread.environment, FILE_POINTER) as { value: string }).value;
      expect(value).toBe(`file://${manualPart}`);
      expect(reread.supplementaryFiles.map((f) => f.part)).toEqual([manualPart]);
      expect(reread.thumbnail?.part).toBe(reread.environment.assetAdministrationShells![0]!.assetInformation.defaultThumbnail?.path);
      expect(decodeUriPath(value)).toBe(MANUAL);
      expect(reread.warnings).toEqual([]);

      // Writing the re-read package again changes nothing — the names are already URIs
      const again = writeAasxWithReport(reread, { version, encodePaths: true });
      expect(again.renamed).toEqual([]);
      expect(again.data).toEqual(writeAasx(reread));
    });
  }

  it('V3.0 is written exactly as before — the names stay as they are, encodePaths or not', () => {
    const pkg = koreanNames();
    const before = writeAasx(pkg);
    const { data, renamed } = writeAasxWithReport(pkg, { version: '3.0', encodePaths: true });
    expect(renamed).toEqual([]);
    expect(data).toEqual(before);
    expect(entries(data)[MANUAL_PART.slice(1)]).toEqual(PDF);
  });

  it('does not touch the input package', () => {
    const pkg = koreanNames();
    const snapshot = JSON.stringify(pkg.environment);
    encodePackagePaths(pkg);
    expect(JSON.stringify(pkg.environment)).toBe(snapshot);
    expect(pkg.supplementaryFiles[0]!.part).toBe(MANUAL_PART);
  });

  it('does not rename onto a part that already exists — the value stays refused instead of losing a file', () => {
    const pkg = koreanNames();
    const taken = '/%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C%20V1.0.pdf';
    pkg.supplementaryFiles.push({ part: taken, contentType: 'application/pdf', data: new Uint8Array([1]) });
    const { renamed } = encodePackagePaths(pkg);
    expect(renamed.map((r) => r.from)).toEqual([PHOTO]);
    expect(() => writeAasxWithReport(pkg, { version: '3.1', encodePaths: true })).toThrow(DowngradeError);
  });
});
