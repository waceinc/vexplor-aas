/**
 * Modbus — 주소 해석(W3C WoT 바인딩 표기) · 값 풀기 · 시험 장치에 붙어 수집기로 읽기.
 */
import { collectOnce, type AidInterface, type ValueSample } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRegisters, ModbusReader, ModbusTestServer, modbusTarget } from '../src/index.js';

describe('Modbus 주소 해석', () => {
  it('절대 주소 · 「/unit/주소」 · 「주소」만 — base 와 합친다', () => {
    expect(modbusTarget(undefined, 'modbus+tcp://10.0.0.5:5020/3/100?quantity=2')).toMatchObject({ host: '10.0.0.5', port: 5020, unitId: 3, address: 100, quantity: 2 });
    expect(modbusTarget('modbus+tcp://10.0.0.5', '/7/40')).toMatchObject({ port: 502, unitId: 7, address: 40, quantity: 1, entity: 'HoldingRegister' });
    expect(modbusTarget('modbus+tcp://10.0.0.5:502/9', '40')).toMatchObject({ unitId: 9, address: 40 });
    expect(modbusTarget('modbus+tcp://10.0.0.5:502', '40', { modv_unitID: '4' })).toMatchObject({ unitId: 4 });
  });

  it('entity · function · type · 바이트 순서 — 원문 기본값(MSB · MSW = true)과 자료형별 레지스터 수', () => {
    expect(modbusTarget('modbus+tcp://h', '/1/0', { modv_entity: 'Coil' })).toMatchObject({ entity: 'Coil', type: 'boolean', quantity: 1 });
    expect(modbusTarget('modbus+tcp://h', '/1/0', { modv_function: 'readInputRegisters', modv_type: 'xsd:float' })).toMatchObject({ entity: 'InputRegister', type: 'float', quantity: 2, msb: true, msw: true });
    expect(modbusTarget('modbus+tcp://h', '/1/0', { 'modv:mostSignificantWord': 'false' })).toMatchObject({ msw: false });
    // 폐지 예정 항목 — false 로 적혀 있을 때만 1 을 뺀다
    expect(modbusTarget('modbus+tcp://h', '/1/40001', { modv_zeroBasedAddressing: 'false' }).address).toBe(40000);
  });

  it('틀린 주소는 거절한다', () => {
    expect(() => modbusTarget(undefined, '40')).toThrow(/base/);
    expect(() => modbusTarget('modbus+tcp://h', '/1/70000')).toThrow(/주소/);
    expect(() => modbusTarget('modbus+tcp://h', '/1/1?quantity=0')).toThrow(/quantity/);
  });

  it('레지스터를 자료형으로 — 부호 · 32비트 · 실수 · 워드 순서 바꿈', () => {
    expect(decodeRegisters([0xfffe], { type: 'short', msb: true, msw: true })).toBe(-2);
    expect(decodeRegisters([0xfffe], { type: 'unsignedShort', msb: true, msw: true })).toBe(65534);
    expect(decodeRegisters([0x0001, 0x0002], { type: 'int', msb: true, msw: true })).toBe(65538);
    expect(decodeRegisters([0x0002, 0x0001], { type: 'int', msb: true, msw: false })).toBe(65538);
    expect(decodeRegisters([0x4148, 0x0000], { type: 'float', msb: true, msw: true })).toBe(12.5);
    expect(decodeRegisters([0x4841, 0x0000], { type: 'float', msb: false, msw: true })).toBe(12.5);
    expect(decodeRegisters([0x4142, 0x4300], { type: 'string', msb: true, msw: true })).toBe('ABC');
  });
});

describe('Modbus 수집 — 시험 장치에 붙어 읽는다', () => {
  let device: ModbusTestServer | undefined;
  let reader: ModbusReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await device?.close();
  });

  it('보유 · 입력 레지스터와 코일을 AID 대로 읽어 표본으로 쌓고, 없는 주소는 사유와 함께 실패로 둔다', async () => {
    device = new ModbusTestServer(999);
    const port = await device.listen();
    device.tables.HoldingRegister.set(10, 1234);
    device.tables.InputRegister.set(20, 0x4148).set(21, 0); // 12.5
    device.tables.Coil.set(5, 1);
    const descriptor: AidInterface = {
      name: 'InterfaceTemplateForModbus',
      protocol: 'MODBUS',
      base: `modbus+tcp://127.0.0.1:${port}/1`,
      properties: [
        { name: 'Counter', href: '10', observable: false, formFields: { modv_type: 'xsd:unsignedShort' } },
        { name: 'Temperature', href: '20', observable: false, formFields: { modv_entity: 'InputRegister', modv_type: 'xsd:float' } },
        { name: 'Running', href: '5', observable: false, formFields: { modv_function: 'readCoil' } },
        { name: 'Missing', href: '5000', observable: false, formFields: {} },
      ],
    };
    reader = await ModbusReader.connect(descriptor);
    const samples: ValueSample[] = [];
    const report = await collectOnce(descriptor, reader, { append: async (batch) => void samples.push(...batch) }, { packageId: 'p1', now: () => '2026-10-14T09:00:00.000Z' });
    expect(Object.fromEntries(samples.map((s) => [s.propertyName, s.valueNumber]))).toEqual({ Counter: 1234, Temperature: 12.5, Running: 1 });
    expect(report.failures).toEqual([{ propertyName: 'Missing', source: '5000', reason: 'IllegalDataAddress' }]);
    expect(samples[0]!.receivedAt).toBe('2026-10-14T09:00:00.000Z');
    // 한 장치에는 연결 하나 — 네 항목을 같은 연결로 읽었다
    expect(device.requests).toBe(4);
  });

  it('장치가 없으면 항목마다 실패 사유를 돌려준다 — 수집기를 멈추지 않는다', async () => {
    const descriptor: AidInterface = { name: 'M', protocol: 'MODBUS', base: 'modbus+tcp://127.0.0.1:1/1', properties: [{ name: 'X', href: '1', observable: false, formFields: {} }] };
    reader = await ModbusReader.connect(descriptor, { timeoutMs: 500 });
    const [result] = await reader.read(['1']);
    expect(result!.error).toBeTruthy();
  });

  it('붙기 전에 주소를 막을 수 있다(체험판 등)', async () => {
    const descriptor: AidInterface = { name: 'M', protocol: 'MODBUS', base: 'modbus+tcp://10.9.9.9/1', properties: [] };
    reader = await ModbusReader.connect(descriptor, {
      guard: () => {
        throw new Error('막힌 주소');
      },
    });
    expect((await reader.read(['1']))[0]!.error).toBe('막힌 주소');
  });
});
