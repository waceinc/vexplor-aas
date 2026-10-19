/**
 * S7 (VEXPLOR extension binding) — address grammar, request planning and reading against the test CPU (s7-mock-server.ts).
 * No real PLC is involved: these tests pin the frames to the published layers, not to a measured CPU.
 */
import { collectOnce, s7Address, s7Endpoint, type AidInterface, type S7Address, type ValueSample } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { planS7Requests, S7Reader } from '../src/index.js';
import { S7MockServer } from './s7-mock-server.js';

describe('S7 address grammar', () => {
  it('endpoint — port 102 and rack 0 · slot 1 by default; rack and slot from the query', () => {
    expect(s7Endpoint('s7://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 102, rack: 0, slot: 1 });
    expect(s7Endpoint('s7://plc.local:1102?rack=0&slot=2')).toEqual({ host: 'plc.local', port: 1102, rack: 0, slot: 2 });
    expect(() => s7Endpoint('s7://10.0.0.5?slot=40')).toThrow(/slot/);
    expect(() => s7Endpoint('modbus+tcp://10.0.0.5')).toThrow(/s7/);
  });

  it('data block, merker, input and output addresses with their default and stated types', () => {
    expect(s7Address('DB10.DBD4:REAL')).toMatchObject({ area: 'DB', db: 10, offset: 4, type: 'REAL', bytes: 4 });
    expect(s7Address('db1.dbx0.3')).toMatchObject({ area: 'DB', db: 1, offset: 0, bit: 3, type: 'BOOL', bytes: 1 });
    expect(s7Address('M10.3')).toMatchObject({ area: 'M', offset: 10, bit: 3, type: 'BOOL' });
    expect(s7Address('MW20:INT')).toMatchObject({ area: 'M', offset: 20, type: 'INT', bytes: 2 });
    expect(s7Address('IB0')).toMatchObject({ area: 'I', offset: 0, type: 'BYTE', bytes: 1 });
    expect(s7Address('EB0')).toMatchObject({ area: 'I' });
    expect(s7Address('QX1.7')).toMatchObject({ area: 'Q', offset: 1, bit: 7 });
    expect(s7Address('DB2.DBB0:STRING[20]')).toMatchObject({ type: 'STRING', length: 20, bytes: 22 });
    expect(s7Address('DB2.DBD8:LREAL')).toMatchObject({ type: 'LREAL', bytes: 8 });
    expect(s7Address('DB2.DBW8:INT16')).toMatchObject({ type: 'INT' });
  });

  it('rejects malformed addresses and a type the size letter cannot hold', () => {
    for (const bad of ['DB0.DBW0', 'DB1.DBX0', 'DB1.DBX0.8', 'MW10.1', 'M10', 'T5', 'DB1.DBW0:REAL', 'MD4:INT', 'MW0:STRING', 'DB1.DBW0:FOO', 'DB1.DBW0:INT:X']) {
      expect(() => s7Address(bad), bad).toThrow();
    }
  });

  it('plans requests within the PDU — long values are split, items capped at 20', () => {
    const many: S7Address[] = Array.from({ length: 45 }, (_, i) => s7Address(`DB1.DBW${i * 2}:INT`));
    // At PDU 240 the request size binds first (12 + 12 × 19 = 240); at 960 the 20-item limit does
    expect(planS7Requests(many, 240).map((request) => request.length)).toEqual([19, 19, 7]);
    expect(planS7Requests(many, 960).map((request) => request.length)).toEqual([20, 20, 5]);
    const long = planS7Requests([s7Address('DB1.DBB0:STRING[254]')], 240);
    expect(long.flat().reduce((sum, piece) => sum + piece.item.bytes, 0)).toBe(256);
    for (const request of long) expect(14 + request.reduce((sum, piece) => sum + 4 + piece.item.bytes + (piece.item.bytes % 2), 0)).toBeLessThanOrEqual(240);
  });
});

describe('S7 collection — reads against the test CPU', () => {
  let cpu: S7MockServer | undefined;
  let reader: S7Reader | undefined;
  afterEach(async () => {
    await reader?.close();
    await cpu?.close();
    reader = undefined;
  });

  const iface = (port: number, hrefs: string[], query = ''): AidInterface => ({
    name: 'InterfaceTemplateForS7',
    protocol: 'S7',
    base: `s7://127.0.0.1:${port}${query}`,
    properties: hrefs.map((href, i) => ({ name: `T${i}`, href, observable: true, formFields: {} })),
  });

  async function start(options?: ConstructorParameters<typeof S7MockServer>[0]): Promise<number> {
    cpu = new S7MockServer(options);
    const db10 = Buffer.alloc(32);
    db10.writeInt16BE(-2, 0);
    db10.writeFloatBE(12.5, 4);
    db10[8] = 0b0000_1000; // DBX8.3
    db10.writeInt32BE(-100000, 10);
    db10.writeDoubleBE(1.25, 16);
    db10.writeUInt16BE(0xabcd, 24);
    cpu.dbs.set(10, db10);
    const db2 = Buffer.alloc(300);
    db2[0] = 254;
    db2[1] = 5;
    db2.write('HELLO', 2, 'latin1');
    db2.write('Z', 250, 'latin1');
    db2[1] = 255; // longer than declared — clipped to the declared maximum
    cpu.dbs.set(2, db2);
    cpu.areas.M[10] = 0b0000_1000;
    cpu.areas.M.writeInt16BE(321, 20);
    cpu.areas.I[0] = 0x5a;
    return cpu.listen();
  }

  it('reads every type big-endian, bits included, in one round trip when it fits', async () => {
    const port = await start();
    const hrefs = ['DB10.DBW0:INT', 'DB10.DBD4:REAL', 'DB10.DBX8.3', 'DB10.DBX8.2', 'DB10.DBD10:DINT', 'DB10.DBD16:LREAL', 'DB10.DBW24', 'M10.3', 'MW20:INT', 'IB0'];
    reader = await S7Reader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results.map((r) => r.value)).toEqual([-2, 12.5, true, false, -100000, 1.25, 0xabcd, true, 321, 0x5a]);
    expect(results.every((r) => r.quality === 'Good' && r.error === undefined)).toBe(true);
    expect(cpu!.readRequests).toBe(1);
  });

  it('a string longer than the PDU is read in pieces and clipped to its declared length; PDU and item limits hold', async () => {
    const port = await start({ pduSize: 240 });
    const hrefs = ['DB2.DBB0:STRING[254]', ...Array.from({ length: 30 }, (_, i) => `DB2.DBB${i + 260}`)];
    reader = await S7Reader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    const text = results[0]!.value as string;
    expect(text.startsWith('HELLO')).toBe(true);
    expect(text).toHaveLength(254);
    expect(text[248]).toBe('Z');
    expect(results.slice(1).every((r) => r.value === 0)).toBe(true);
    expect(cpu!.readRequests).toBeGreaterThan(1);
    expect(cpu!.violations).toBe(0);
  });

  it('a missing DB, an address past the end and a malformed address fail alone — the rest is read', async () => {
    const port = await start();
    const hrefs = ['DB10.DBW0:INT', 'DB99.DBW0', 'DB10.DBD30:REAL', 'DB10.DBQ0', 'MW20:INT'];
    reader = await S7Reader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results[0]!.value).toBe(-2);
    expect(results[1]!.error).toMatch(/ObjectDoesNotExist/);
    expect(results[2]!.error).toMatch(/AddressOutOfRange/);
    expect(results[3]!.error).toMatch(/S7/);
    expect(results[4]!.value).toBe(321);
  });

  it('reconnects after the connection drops and after the CPU was away', async () => {
    const port = await start();
    reader = await S7Reader.connect(iface(port, ['MW20:INT']), { timeoutMs: 1000 });
    expect((await reader.read(['MW20:INT']))[0]!.value).toBe(321);
    cpu!.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await reader.read(['MW20:INT']))[0]!.value).toBe(321);
    expect(cpu!.connections).toBe(2);
  });

  it('a CPU that stops answering times out, the connection is dropped and the next read works again', async () => {
    const port = await start();
    reader = await S7Reader.connect(iface(port, ['MW20:INT']), { timeoutMs: 300 });
    expect((await reader.read(['MW20:INT']))[0]!.value).toBe(321);
    cpu!.silent = true;
    expect((await reader.read(['MW20:INT']))[0]!.error).toBe('Timeout');
    cpu!.silent = false;
    expect((await reader.read(['MW20:INT']))[0]!.value).toBe(321);
  });

  it('says what to switch on when the CPU refuses PUT/GET, and what to check when rack or slot is wrong', async () => {
    let port = await start();
    cpu!.refuse = 0x8104;
    reader = await S7Reader.connect(iface(port, ['MW20:INT']), { timeoutMs: 1000 });
    expect((await reader.read(['MW20:INT']))[0]!.error).toMatch(/PUT\/GET/);
    await reader.close();
    await cpu!.close();
    port = await start({ slot: 2 });
    reader = await S7Reader.connect(iface(port, ['MW20:INT'], '?slot=1'), { timeoutMs: 1000 });
    expect((await reader.read(['MW20:INT']))[0]!.error).toMatch(/rack/);
  });

  it('feeds the collector — values become samples; an absent CPU is a reason per item; a guard can block it', async () => {
    const port = await start();
    const descriptor = iface(port, ['DB10.DBD4:REAL', 'DB99.DBW0']);
    reader = await S7Reader.connect(descriptor, { timeoutMs: 1000 });
    const stored: ValueSample[] = [];
    const report = await collectOnce(descriptor, reader, { append: async (samples) => void stored.push(...samples) }, { packageId: 'p1' });
    expect(report.collected).toBe(1);
    expect(stored.find((s) => s.propertyName === 'T0')?.valueNumber).toBe(12.5);
    expect(report.failures[0]?.reason).toMatch(/ObjectDoesNotExist/);

    const absent = await S7Reader.connect({ ...descriptor, base: 's7://127.0.0.1:1' }, { timeoutMs: 300 });
    expect((await absent.read(['DB10.DBD4:REAL']))[0]!.error).toBeTruthy();
    const blocked = await S7Reader.connect(descriptor, { guard: () => { throw new Error('blocked'); } });
    expect((await blocked.read(['DB10.DBD4:REAL']))[0]!.error).toBe('blocked');
  });
});
