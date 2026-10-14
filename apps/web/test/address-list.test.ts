/**
 * Collected address list tests.
 *
 * This table is the sheet handed to the OT team at commissioning. A missing or wrong address sends people down the wrong path.
 * So more than "does every address appear", we check **"can you tell from the table whether an address works"**.
 */
import { localTime } from '../src/model.js';
import { describe, expect, it } from 'vitest';
import { ADDRESS_COLUMNS, addressCsv, addressRows } from '../src/addressList.js';
import type { AidInterfaceView, CollectedValueView, LiveMapping } from '../src/api.js';

const roller: AidInterfaceView = {
  name: 'InterfaceTemplateForOPCUA',
  title: '롤포밍기',
  protocol: 'OPCUA',
  base: 'opc.tcp://192.168.0.50:4840',
  properties: [
    { name: 'RotationSpeed', type: 'float', unit: 'rpm', href: 'ns=1;s=Machine.Speed', observable: true },
    { name: 'DoorOpen', type: 'boolean', href: 'ns=1;s=Machine.Door', observable: false },
  ],
};

describe('addressRows', () => {
  it('each tag of each interface becomes one row', () => {
    const rows = addressRows([roller]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      interfaceName: '롤포밍기',
      protocol: 'OPCUA',
      endpoint: 'opc.tcp://192.168.0.50:4840',
      propertyName: 'RotationSpeed',
      address: 'ns=1;s=Machine.Speed',
      dataType: 'float',
      unit: 'rpm',
      observable: '예',
    });
    expect(rows[1]?.observable).toBe('아니오');
  });

  it('falls back to idShort when title is missing', () => {
    const [row] = addressRows([{ ...roller, title: undefined }]);
    expect(row?.interfaceName).toBe('InterfaceTemplateForOPCUA');
  });

  it('when a tag has several values, only the latest is attached', () => {
    const values: CollectedValueView[] = [
      {
        interfaceName: 'InterfaceTemplateForOPCUA',
        propertyName: 'RotationSpeed',
        valueNumber: 100,
        quality: 'Good',
        observedAt: '2026-08-31T01:00:00.000Z',
      },
      {
        interfaceName: 'InterfaceTemplateForOPCUA',
        propertyName: 'RotationSpeed',
        valueNumber: 250,
        quality: 'Good',
        observedAt: '2026-08-31T02:00:00.000Z',
      },
    ] as CollectedValueView[];
    const [row] = addressRows([roller], values);
    expect(row?.latestValue).toBe('250');
    expect(row?.observedAt).toBe(localTime('2026-08-31T02:00:00.000Z')); // in this PC's time zone (fixed from printing raw UTC, 2026-09-10)
  });

  it('Important: distinguishes "asked but no value" from "not asked yet"', () => {
    // On the commissioning checklist these are completely different: the first means the equipment is not ready, the second means nobody checked
    const [waiting, untouched] = addressRows([roller], [], undefined, new Set(['RotationSpeed']));
    expect(waiting?.quality).toBe('값 대기');
    expect(untouched?.quality).toBe('');
  });

  it('tags not yet collected leave the value cell empty (nothing is made up)', () => {
    const rows = addressRows([roller]);
    expect(rows[0]?.latestValue).toBe('');
    expect(rows[0]?.quality).toBe('');
    expect(rows[0]?.observedAt).toBe('');
  });

  it('Important: a name that does not match the model shows up in the table (values pile up but are invisible from outside)', () => {
    const live: LiveMapping = {
      collected: 2,
      applied: 1,
      notes: [
        { propertyName: 'RotationSpeed', outcome: 'applied', paths: ['a'] },
        { propertyName: 'DoorOpen', outcome: 'unmatched', paths: [] },
      ],
    };
    const rows = addressRows([roller], [], live);
    expect(rows[0]?.modelLink).toBe('연결됨');
    expect(rows[1]?.modelLink).toBe('이름 안 맞음');
  });

  it('when a name matches several places, records how many', () => {
    const live: LiveMapping = {
      collected: 1,
      applied: 0,
      notes: [{ propertyName: 'RotationSpeed', outcome: 'ambiguous', paths: ['a', 'b'] }],
    };
    expect(addressRows([roller], [], live)[0]?.modelLink).toBe('이름 중복 (2곳)');
  });

  it('keeps tags without an address (finding missing addresses is what this table is for)', () => {
    const [row] = addressRows([
      { ...roller, properties: [{ name: 'Temp', observable: true }] },
    ]);
    expect(row?.address).toBe('');
    expect(row?.propertyName).toBe('Temp');
  });
});

describe('addressCsv', () => {
  it('starts with a BOM so Excel does not garble Korean', () => {
    expect(addressCsv(addressRows([roller]))).toMatch(/^﻿/);
  });

  it('header and column counts match', () => {
    const lines = addressCsv(addressRows([roller])).split('\r\n');
    expect(lines[0]).toBe(`﻿${ADDRESS_COLUMNS.map((c) => `"${c}"`).join(',')}`);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.split(',')).toHaveLength(ADDRESS_COLUMNS.length);
  });

  it('does not break values containing double quotes', () => {
    const csv = addressCsv(addressRows([{ ...roller, title: '롤포밍기 "A"동' }]));
    expect(csv).toContain('"롤포밍기 ""A""동"');
  });
});
