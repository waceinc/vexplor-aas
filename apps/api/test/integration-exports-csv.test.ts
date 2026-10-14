/**
 * CSV form of the exports (design §4.4; ERP E-4, E-13): round trip to the JSON values, UTF-8 BOM, CRLF, RFC 4180
 * quoting, formula-injection guard, header variants.
 */
import { parseCsv } from '@aas/linter';
import { describe, expect, it } from 'vitest';
import { EQUIPMENT_V1_COLUMNS } from '../src/integration/exports/columns.js';
import { cellText, joinMulti, splitMulti, toCsvText } from '../src/integration/exports/csv.js';
import { equipmentRow, type EquipmentItem } from '../src/integration/exports/equipment.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { element, harness, submodel, unitCopy, type Json } from './helpers/integration-fixtures.js';

const MARKINGS = ['CE 2006/42/EC', 'KCs S-인증; 안전', 'say "hi"', 'two\nlines', 'back\\slash'];

async function tricky() {
  const pkg = unitCopy(1, (env) => {
    const plate = submodel(env, 'DigitalNameplate');
    element(plate, 'ManufacturerProductDesignation')['value'] = [{ language: 'ko', text: '롤포밍 "라인", 자동차\n차체' }];
    const list = element(plate, 'Markings');
    const template = (list['value'] as Json[])[0]!;
    list['value'] = MARKINGS.map((name, i) => {
      const entry = structuredClone(template);
      entry['idShort'] = `MarkingsEntry_${i}`;
      element(entry, 'MarkingName')['value'] = name;
      return entry;
    });
    // Formula injection: a value an attacker could plant in someone else's AASX
    element(submodel(env, 'TechnicalData'), 'GeneralInformation.ManufacturerOrderCode')['value'] = '=HYPERLINK("http://x","y")';
    element(submodel(env, 'TechnicalData'), 'TechnicalPropertyAreas.TechnicalPropertyAreasEntry_0.GeneralEquipmentSpecification.DimensionSpec.TotalWeight')['value'] = '-12.5';
  });
  const store = createIntegrationStore();
  await store.importPackage({ name: 'tricky.aasx', package: pkg });
  return harness(store);
}

describe('equipment CSV', () => {
  it('parses back to the JSON values — Korean, commas, quotes, newlines, ; in lists (E-4)', async () => {
    const { call } = await tricky();
    const item = (((await call('GET', '/integrations/exports/equipment')).body as Json)['items'] as EquipmentItem[])[0]!;
    expect(item.nameplate.markings).toEqual(MARKINGS);
    const csv = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } })).body as Uint8Array);
    const [header, row, ...rest] = parseCsv(csv);
    expect(rest).toEqual([]);
    expect(header).toEqual([...EQUIPMENT_V1_COLUMNS]);
    const parsed = Object.fromEntries(header!.map((key, i) => [key, row![i]!]));
    const expected = equipmentRow(item);
    for (const key of EQUIPMENT_V1_COLUMNS) expect(parsed[key], key).toBe(cellText(expected[key]));
    expect(splitMulti(parsed['nameplate.markings']!)).toEqual(MARKINGS);
    expect(parsed['nameplate.productDesignation']).toBe('롤포밍 "라인", 자동차\n차체');
    expect(parsed['nameplate.orderCode']).toBe('=HYPERLINK("http://x","y")');
    expect(Number(parsed['physical.weight.value'])).toBe(item.physical.weight!.value);
  });

  it('neutralises formulas in the raw text but keeps negative numbers (E-13)', async () => {
    const { call } = await tricky();
    const csv = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } })).body as Uint8Array);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain(',-12.5,');
  });

  it('ends lines with CRLF and adds the UTF-8 BOM only with bom=1 (E-13)', async () => {
    const { call } = await tricky();
    const plain = (await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } })).body as Uint8Array;
    const withBom = (await call('GET', '/integrations/exports/equipment', { query: { format: 'csv', bom: '1' } })).body as Uint8Array;
    expect([...plain.slice(0, 3)]).toEqual([...new TextEncoder().encode('key')]);
    expect([...withBom.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(withBom.slice(3)).toEqual(plain);
    const textValue = new TextDecoder().decode(plain);
    expect(textValue.endsWith('\r\n')).toBe(true);
    // Two records → two record separators; the newline inside the quoted designation stays a bare \n
    expect(textValue.split('\r\n')).toHaveLength(3);
  });

  it('writes human labels with headers=ko and a schema line with meta=1', async () => {
    const { call } = await tricky();
    const ko = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv', headers: 'ko' } })).body as Uint8Array);
    expect(ko.split('\r\n')[0]!.startsWith('설비 키(globalAssetId),AAS ID,자산 종류')).toBe(true);
    const en = new TextDecoder().decode(
      (await call('GET', '/integrations/exports/equipment', { query: { format: 'csv', headers: 'ko' }, headers: { 'accept-language': 'en' } })).body as Uint8Array,
    );
    expect(en.split('\r\n')[0]!.includes('제조사')).toBe(false);
    const meta = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv', meta: '1' } })).body as Uint8Array);
    expect(meta.split('\r\n')[0]).toBe('#schema=vexplor.equipmentMaster/1');
  });
});

describe('list cells in ;-delimited spreadsheet locales (L6)', () => {
  it('guards every element against formulas and quotes a cell that contains ;', async () => {
    const markings = ['=1+1', 'a;=2+2', '-5', '@SUM(A1)', 'ok'];
    const pkg = unitCopy(1, (env) => {
      const list = element(submodel(env, 'DigitalNameplate'), 'Markings');
      const template = (list['value'] as Json[])[0]!;
      list['value'] = markings.map((name, i) => {
        const entry = structuredClone(template);
        entry['idShort'] = `MarkingsEntry_${i}`;
        element(entry, 'MarkingName')['value'] = name;
        return entry;
      });
    });
    const store = createIntegrationStore();
    await store.importPackage({ name: 'list.aasx', package: pkg });
    const { call } = harness(store);
    const csv = new TextDecoder().decode((await call('GET', '/integrations/exports/equipment', { query: { format: 'csv' } })).body as Uint8Array);
    // Each element that could start a formula is neutralised; the cell is quoted so a ; delimiter cannot split it
    expect(csv).toContain(`"'=1+1;a\\;=2+2;-5;'@SUM(A1);ok"`);
    const [header, row] = parseCsv(csv);
    expect(splitMulti(row![header!.indexOf('nameplate.markings')]!)).toEqual(markings);
  });

  it('quotes any cell containing ; even outside lists', () => {
    expect(toCsvText(['a'], [{ a: 'x;y' }], { bom: false, headers: 'keys', meta: false, schema: 's' })).toBe('a\r\n"x;y"\r\n');
  });
});

describe('multi-value cells', () => {
  it('escape ; and \\ so the list splits back exactly', () => {
    const values = ['a;b', 'c\\;d', '', 'e\\'];
    expect(splitMulti(joinMulti(values))).toEqual(values);
    expect(joinMulti(['x;y'])).toBe('x\\;y');
    expect(splitMulti('')).toEqual([]);
  });
});
