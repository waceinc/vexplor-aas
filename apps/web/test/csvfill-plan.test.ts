/**
 * Fill values from CSV: the planning part. Guess column mapping, find files, only changed values, empty cells never clear.
 */
import { describe, expect, it } from 'vitest';
import { guessKeyColumn, leavesOf, planFill, suggestTarget, type FileTarget } from '../src/components/csvfill/plan.js';

const nameplate = (serial: string): Record<string, unknown> => ({
  idShort: 'DigitalNameplate',
  submodelElements: [
    { idShort: 'SerialNumber', modelType: 'Property', value: serial },
    { idShort: 'ManufacturerName', modelType: 'MultiLanguageProperty', value: [{ language: 'ko', text: '웨이스' }] },
    { idShort: 'Address', modelType: 'SubmodelElementCollection', value: [{ idShort: 'CityTown', modelType: 'Property', value: '' }] },
    { idShort: 'Range1', modelType: 'Range', min: '1', max: '2' },
    { idShort: 'Markings', modelType: 'SubmodelElementList', value: [{ modelType: 'Property', value: 'x' }] },
  ],
});

const file = (packageId: string, names: string[], serial?: string): FileTarget => ({
  packageId,
  names,
  ...(serial !== undefined ? { submodel: { id: `sm-${packageId}`, content: nameplate(serial) } } : {}),
});

describe('fill values from CSV: planning', () => {
  it('value items are listed by path into collections, and ordered lists are skipped', () => {
    expect(leavesOf(nameplate('A')).map((leaf) => [leaf.path, leaf.current])).toEqual([
      ['SerialNumber', 'A'],
      ['ManufacturerName', '웨이스'],
      ['Address.CityTown', ''],
      ['Range1', '1~2'],
    ]);
  });

  it('column mapping only on identical names (case, spaces and underscores ignored; similar names are not picked)', () => {
    const leaves = leavesOf(nameplate('A'));
    expect(suggestTarget('serial number', leaves)).toBe('SerialNumber');
    expect(suggestTarget('City_Town', leaves)).toBe('Address.CityTown');
    expect(suggestTarget('Serial', leaves)).toBeUndefined();
    expect(guessKeyColumn(['SerialNumber', '설비명', 'X'])).toBe(1);
    expect(guessKeyColumn(['A', 'B'])).toBe(0);
  });

  it('finds the file per row and keeps only changed values (same values and empty cells dropped; flags not found, no submodel and duplicates)', () => {
    const plans = planFill({
      rows: [
        ['RFM_1', 'SN-1', 'Seoul'],
        ['rfm_2', 'SN-OLD', ''],
        ['Ghost', 'SN-9', 'x'],
        ['Bare', 'SN-3', 'x'],
        ['RFM_1', 'SN-again', 'x'],
      ],
      keyColumn: 0,
      mapping: [undefined, 'SerialNumber', 'Address.CityTown'],
      files: [file('p1', ['RFM_1'], 'SN-OLD'), file('p2', ['RFM_2'], 'SN-OLD'), file('p3', ['Bare'])],
    });
    expect(plans[0]).toEqual({
      key: 'RFM_1',
      packageId: 'p1',
      changes: [
        { path: 'SerialNumber', before: 'SN-OLD', after: 'SN-1' },
        { path: 'Address.CityTown', before: '', after: 'Seoul' },
      ],
    });
    expect(plans[1]).toEqual({ key: 'rfm_2', packageId: 'p2', changes: [] }); // same value / empty cell
    expect(plans[2]).toMatchObject({ key: 'Ghost', problem: 'no-file' });
    expect(plans[3]).toMatchObject({ key: 'Bare', problem: 'no-submodel' });
    expect(plans[4]).toMatchObject({ key: 'RFM_1', problem: 'duplicate' });
  });
});
