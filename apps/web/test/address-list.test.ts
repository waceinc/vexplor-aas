/**
 * 수집 주소 목록 검증.
 *
 * 이 표는 시운전 때 OT팀에 넘어가는 종이다. 주소가 빠지거나 어긋나면 사람이 헛짚는다.
 * 그래서 「주소가 다 나오는가」보다 **「되는 주소인지 표에서 보이는가」**를 더 본다.
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
  it('인터페이스마다 태그 하나가 한 줄이 된다', () => {
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

  it('title이 없으면 idShort로 적는다', () => {
    const [row] = addressRows([{ ...roller, title: undefined }]);
    expect(row?.interfaceName).toBe('InterfaceTemplateForOPCUA');
  });

  it('같은 태그의 값이 여럿이면 가장 최근 것만 붙는다', () => {
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
    expect(row?.observedAt).toBe(localTime('2026-08-31T02:00:00.000Z')); // 이 PC 시간대로 (UTC 그대로 찍던 것을 고쳤다, 2026-09-10)
  });

  it('🔴 「물어봤는데 값이 없다」와 「아직 안 물어봤다」를 가른다', () => {
    // 시운전 점검표에서 이 둘은 전혀 다르다 — 앞은 설비가 아직 준비 안 된 것, 뒤는 확인 자체를 안 한 것
    const [waiting, untouched] = addressRows([roller], [], undefined, new Set(['RotationSpeed']));
    expect(waiting?.quality).toBe('값 대기');
    expect(untouched?.quality).toBe('');
  });

  it('아직 수집하지 않은 태그는 값 칸이 빈다 — 지어내지 않는다', () => {
    const rows = addressRows([roller]);
    expect(rows[0]?.latestValue).toBe('');
    expect(rows[0]?.quality).toBe('');
    expect(rows[0]?.observedAt).toBe('');
  });

  it('🔴 이름이 모델과 안 맞으면 표에 드러난다 — 값은 쌓이는데 밖에서 안 보이는 상태', () => {
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

  it('이름이 여러 곳에 겹치면 몇 곳인지 적는다', () => {
    const live: LiveMapping = {
      collected: 1,
      applied: 0,
      notes: [{ propertyName: 'RotationSpeed', outcome: 'ambiguous', paths: ['a', 'b'] }],
    };
    expect(addressRows([roller], [], live)[0]?.modelLink).toBe('이름 중복 (2곳)');
  });

  it('주소가 없는 태그도 빠뜨리지 않는다 — 빠진 주소를 찾는 것이 이 표의 쓰임새다', () => {
    const [row] = addressRows([
      { ...roller, properties: [{ name: 'Temp', observable: true }] },
    ]);
    expect(row?.address).toBe('');
    expect(row?.propertyName).toBe('Temp');
  });
});

describe('addressCsv', () => {
  it('엑셀이 한글을 깨뜨리지 않게 BOM으로 시작한다', () => {
    expect(addressCsv(addressRows([roller]))).toMatch(/^﻿/);
  });

  it('머리글과 칸 수가 맞는다', () => {
    const lines = addressCsv(addressRows([roller])).split('\r\n');
    expect(lines[0]).toBe(`﻿${ADDRESS_COLUMNS.map((c) => `"${c}"`).join(',')}`);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.split(',')).toHaveLength(ADDRESS_COLUMNS.length);
  });

  it('큰따옴표가 든 값을 깨뜨리지 않는다', () => {
    const csv = addressCsv(addressRows([{ ...roller, title: '롤포밍기 "A"동' }]));
    expect(csv).toContain('"롤포밍기 ""A""동"');
  });
});
