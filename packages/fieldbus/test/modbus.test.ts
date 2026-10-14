/**
 * Modbus — address parsing (W3C WoT binding notation) · value decoding · reading via the collector against a test device.
 */
import { collectOnce, type AidInterface, type ValueSample } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRegisters, ModbusReader, ModbusTestServer, modbusTarget } from '../src/index.js';

describe('Modbus address parsing', () => {
  it('absolute address · "/unit/address" · "address" only — combined with base', () => {
    expect(modbusTarget(undefined, 'modbus+tcp://10.0.0.5:5020/3/100?quantity=2')).toMatchObject({ host: '10.0.0.5', port: 5020, unitId: 3, address: 100, quantity: 2 });
    expect(modbusTarget('modbus+tcp://10.0.0.5', '/7/40')).toMatchObject({ port: 502, unitId: 7, address: 40, quantity: 1, entity: 'HoldingRegister' });
    expect(modbusTarget('modbus+tcp://10.0.0.5:502/9', '40')).toMatchObject({ unitId: 9, address: 40 });
    expect(modbusTarget('modbus+tcp://10.0.0.5:502', '40', { modv_unitID: '4' })).toMatchObject({ unitId: 4 });
  });

  it('entity · function · type · byte order — spec defaults (MSB · MSW = true) and register count per data type', () => {
    expect(modbusTarget('modbus+tcp://h', '/1/0', { modv_entity: 'Coil' })).toMatchObject({ entity: 'Coil', type: 'boolean', quantity: 1 });
    expect(modbusTarget('modbus+tcp://h', '/1/0', { modv_function: 'readInputRegisters', modv_type: 'xsd:float' })).toMatchObject({ entity: 'InputRegister', type: 'float', quantity: 2, msb: true, msw: true });
    expect(modbusTarget('modbus+tcp://h', '/1/0', { 'modv:mostSignificantWord': 'false' })).toMatchObject({ msw: false });
    // Deprecated field — subtracts 1 only when it is written as false
    expect(modbusTarget('modbus+tcp://h', '/1/40001', { modv_zeroBasedAddressing: 'false' }).address).toBe(40000);
  });

  it('rejects invalid addresses', () => {
    expect(() => modbusTarget(undefined, '40')).toThrow(/base/);
    expect(() => modbusTarget('modbus+tcp://h', '/1/70000')).toThrow(/주소/);
    expect(() => modbusTarget('modbus+tcp://h', '/1/1?quantity=0')).toThrow(/quantity/);
  });

  it('registers to data types — sign · 32-bit · floating point · swapped word order', () => {
    expect(decodeRegisters([0xfffe], { type: 'short', msb: true, msw: true })).toBe(-2);
    expect(decodeRegisters([0xfffe], { type: 'unsignedShort', msb: true, msw: true })).toBe(65534);
    expect(decodeRegisters([0x0001, 0x0002], { type: 'int', msb: true, msw: true })).toBe(65538);
    expect(decodeRegisters([0x0002, 0x0001], { type: 'int', msb: true, msw: false })).toBe(65538);
    expect(decodeRegisters([0x4148, 0x0000], { type: 'float', msb: true, msw: true })).toBe(12.5);
    expect(decodeRegisters([0x4841, 0x0000], { type: 'float', msb: false, msw: true })).toBe(12.5);
    expect(decodeRegisters([0x4142, 0x4300], { type: 'string', msb: true, msw: true })).toBe('ABC');
  });
});

describe('Modbus collection — reads against a test device', () => {
  let device: ModbusTestServer | undefined;
  let reader: ModbusReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await device?.close();
  });

  it('reads holding/input registers and coils per the AID into samples, and leaves a missing address as a failure with a reason', async () => {
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
    // One connection per device — the four items were read over the same connection
    expect(device.requests).toBe(4);
  });

  it('returns a failure reason per item when the device is absent — does not stop the collector', async () => {
    const descriptor: AidInterface = { name: 'M', protocol: 'MODBUS', base: 'modbus+tcp://127.0.0.1:1/1', properties: [{ name: 'X', href: '1', observable: false, formFields: {} }] };
    reader = await ModbusReader.connect(descriptor, { timeoutMs: 500 });
    const [result] = await reader.read(['1']);
    expect(result!.error).toBeTruthy();
  });

  it('can block an address before connecting (e.g. trial edition)', async () => {
    const descriptor: AidInterface = { name: 'M', protocol: 'MODBUS', base: 'modbus+tcp://10.9.9.9/1', properties: [] };
    reader = await ModbusReader.connect(descriptor, {
      guard: () => {
        throw new Error('막힌 주소');
      },
    });
    expect((await reader.read(['1']))[0]!.error).toBe('막힌 주소');
  });
});
