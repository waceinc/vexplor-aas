/**
 * XGT dedicated protocol (VEXPLOR extension binding) — address grammar, batching and reading against the test CPU
 * (xgt-mock-server.ts). No real PLC is involved: these tests pin the frames to the published manuals, not to a
 * measured CPU. Where the manuals give a worked address (`%MX2764` = bit C of M172, `L5120` = `%LX8192`,
 * `L514` = `%LD257`, `D1234` = `%DB2468`), the test uses it.
 */
import { readFileSync } from 'node:fs';
import { xgtAddress, xgtEndpoint, type AidInterface, type XgtAddress } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { XgtReader, headerSum, planXgtRequests } from '../src/index.js';
import { XgtMockServer } from './xgt-mock-server.js';

const at = (href: string, series?: Parameters<typeof xgtAddress>[1]): unknown => {
  const address = xgtAddress(href, series);
  return address.mode === 'block' ? { byte: address.byte, bit: address.bit, bytes: address.bytes, type: address.type } : { name: address.name, size: address.size, type: address.type };
};

describe('XGT address grammar', () => {
  it('endpoint — port 2004 and series XGK unless stated; the series names the manuals use', () => {
    expect(xgtEndpoint('xgt://10.0.0.9')).toEqual({ host: '10.0.0.9', port: 2004, series: 'XGK' });
    expect(xgtEndpoint('xgt://10.0.0.9:2104?series=xgi')).toEqual({ host: '10.0.0.9', port: 2104, series: 'XGI' });
    expect(xgtEndpoint('xgt://h?series=XGB-IEC').series).toBe('XEC');
    expect(xgtEndpoint('xgt://h?series=XGB').series).toBe('XGB');
    expect(() => xgtEndpoint('xgt://h?series=XGZ')).toThrow(/series/);
    expect(() => xgtEndpoint('s7://h')).toThrow();
  });

  it('header BCC is the byte sum of the first 19 bytes — the manual examples (XGB FEnet Table 5-8, 5-7) give 0x3F and 0x2F', () => {
    const request = Buffer.from([0x4c, 0x53, 0x49, 0x53, 0x2d, 0x58, 0x47, 0x54, 0, 0, 0, 0, 0xa0, 0x33, 0x00, 0x01, 0x10, 0x00, 0x00, 0x3f]);
    expect(headerSum(request)).toBe(0x3f);
    // The answer example has a non-zero position byte (0x03), so it also pins that byte 18 is part of the sum
    const answer = Buffer.from([0x4c, 0x53, 0x49, 0x53, 0x2d, 0x58, 0x47, 0x54, 0, 0, 0x11, 0x01, 0xa0, 0x11, 0x00, 0x00, 0x0e, 0x00, 0x03, 0x2f]);
    expect(headerSum(answer)).toBe(0x2f);
  });

  it('XGK notation — words, bits of words, bits of bit devices, contacts; the manual examples line up', () => {
    expect(at('D100')).toEqual({ byte: 200, bit: undefined, bytes: 2, type: 'INT' });
    expect(at('D1234:WORD')).toEqual(at('%DW1234'));
    expect(at('%DB2468')).toMatchObject({ byte: 2468 });
    expect(at('D200:REAL')).toMatchObject({ byte: 400, bytes: 4, type: 'REAL' });
    expect(at('D100.3')).toMatchObject({ byte: 200, bit: 3, type: 'BOOL' });
    expect(at('D100.B')).toMatchObject({ byte: 201, bit: 3 });
    expect(at('P0001A')).toMatchObject({ byte: 3, bit: 2, type: 'BOOL' });
    expect(at('M172C')).toEqual(at('%MX2764'));
    expect(at('L5120:BOOL')).toEqual(at('%LX8192'));
    expect(at('L514:DWORD')).toEqual(at('%LD257'));
    expect(at('M0010:BOOL')).toMatchObject({ byte: 2, bit: 0 });
    expect(at('T10:BOOL')).toEqual({ name: '%TX10', size: 'X', type: 'BOOL' });
    expect(at('T10')).toMatchObject({ byte: 20, bytes: 2, type: 'INT' });
    expect(at('R0:STRING[10]')).toMatchObject({ byte: 0, bytes: 10, type: 'STRING' });
  });

  it('IEC notation (XGI · XGR · XEC) — flat devices by byte, I / Q by name', () => {
    expect(at('%MW100', 'XGI')).toMatchObject({ byte: 200, bytes: 2, type: 'WORD' });
    expect(at('%MD10:REAL', 'XGI')).toMatchObject({ byte: 40, bytes: 4, type: 'REAL' });
    expect(at('%MX1603', 'XGR')).toMatchObject({ byte: 200, bit: 3 });
    expect(at('%ML1', 'XEC')).toMatchObject({ byte: 8, bytes: 8, type: 'ULINT' });
    expect(at('%MB4:STRING[10]', 'XGI')).toMatchObject({ byte: 4, bytes: 10 });
    expect(at('%IX0.0.3', 'XGI')).toEqual({ name: '%IX0.0.3', size: 'X', type: 'BOOL' });
    expect(at('%qw0.1.2:INT', 'XGI')).toEqual({ name: '%QW0.1.2', size: 'W', type: 'INT' });
  });

  it('rejects malformed addresses, devices of another series and types an address cannot hold', () => {
    for (const bad of ['D', 'Z10', 'U00.00', 'D100:BOOL', 'D100.G', 'D100:BYTE', 'P0001A:INT', 'T10.3', '%IX0.0.3', 'D100:FOO', '%WW10', 'D1234567']) {
      expect(() => xgtAddress(bad, 'XGK'), bad).toThrow();
    }
    for (const bad of ['D100', '%DW100', '%MW10:BYTE', '%MX10:INT', '%IX0.0.3:INT', '%IW0.0.0:REAL', '%IB0.0.0:STRING[2]', '%PX0', '%MD1:INT']) {
      expect(() => xgtAddress(bad, 'XGI'), bad).toThrow();
    }
    expect(() => xgtAddress('%IX0.0.3', 'XGK')).toThrow(/series/);
  });

  it('merges neighbours on one device into continuous reads ≤ 1,400 bytes, and groups named reads 16 at a time', () => {
    const addresses: XgtAddress[] = ['D100', 'D101', 'D110:DINT', 'D2000', 'M0010:BOOL', 'M0011:BOOL', 'T10:BOOL', 'T11:BOOL'].map((a) => xgtAddress(a));
    const plan = planXgtRequests(addresses);
    expect(plan.map((r) => (r.kind === 'block' ? [r.device, r.start, r.bytes, r.members.length] : [r.size, r.members.length]))).toEqual([
      ['D', 200, 24, 3],
      ['D', 4000, 2, 1],
      ['M', 2, 1, 2],
      ['X', 2],
    ]);
    const wide = planXgtRequests(Array.from({ length: 100 }, (_, i) => xgtAddress(`D${i * 10}:LREAL`)));
    expect(wide.every((r) => r.kind === 'block' && r.bytes <= 1400)).toBe(true);
    expect(wide.length).toBe(2);
    const contacts = planXgtRequests(Array.from({ length: 33 }, (_, i) => xgtAddress(`C${i}:BOOL`)));
    expect(contacts.map((r) => r.members.length)).toEqual([16, 16, 1]);
  });
});

describe('XGT collection — reads against the test CPU', () => {
  let cpu: XgtMockServer | undefined;
  let reader: XgtReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await cpu?.close();
    reader = undefined;
  });

  const iface = (port: number, hrefs: string[], query = ''): AidInterface => ({
    name: 'InterfaceTemplateForXGT',
    protocol: 'XGT',
    base: `xgt://127.0.0.1:${port}${query}`,
    properties: hrefs.map((href, i) => ({ name: `T${i}`, href, observable: true, formFields: {} })),
  });

  async function start(): Promise<number> {
    cpu = new XgtMockServer();
    const d = cpu.memory.get('D')!;
    d.writeInt16LE(-2, 200);
    d.writeUInt16LE(0xbeef, 202);
    d.writeFloatLE(12.5, 204);
    d.writeInt32LE(-100000, 208);
    d.writeDoubleLE(1.25, 212);
    d.writeUInt16LE(0b1000, 20);
    d.write('PRESS', 400, 'latin1');
    cpu.memory.get('P')![3] = 0b100;
    cpu.memory.get('M')![2] = 1;
    cpu.memory.get('L')!.writeUInt32LE(70000, 1028);
    cpu.memory.get('T')!.writeUInt16LE(1234, 20);
    cpu.contacts.get('T')!.add(10);
    return cpu.listen();
  }

  it('reads XGK words little-endian, bits and contacts, in few requests within the published limits', async () => {
    const port = await start();
    const hrefs = ['D100', 'D101:UINT', 'D102:REAL', 'D104:DINT', 'D106:LREAL', 'D10.3', 'D10.2', 'P0001A', 'M0010:BOOL', 'L514:DWORD', 'D200:STRING[10]', 'T10:BOOL', 'T10'];
    reader = await XgtReader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results.map((r) => r.error ?? r.value)).toEqual([-2, 0xbeef, 12.5, -100000, 1.25, true, false, true, true, 70000, 'PRESS', true, 1234]);
    expect(results.every((r) => r.quality === 'Good')).toBe(true);
    // D10 · D100–D107 · D200 (three D blocks) · P · M · L · T current value · T contact
    expect(cpu!.requests).toBe(8);
    expect(cpu!.violations).toEqual([]);
    expect(cpu!.cpuInfo).toBe(0xa0);
  });

  it('reads XGI flat devices and I / Q by name, with the XGI CPU info byte', async () => {
    const port = await start();
    cpu!.memory.get('M')!.writeUInt16LE(0x1234, 200);
    cpu!.memory.get('M')!.writeFloatLE(-0.5, 204);
    cpu!.io.set('%IX0.0.3', Buffer.from([1]));
    cpu!.io.set('%QW0.1.2', Buffer.from([0x34, 0x12]));
    const hrefs = ['%MW100', '%MD51:REAL', '%MX1603', '%IX0.0.3', '%QW0.1.2'];
    reader = await XgtReader.connect(iface(port, hrefs, '?series=XGI'), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results.map((r) => r.error ?? r.value)).toEqual([0x1234, -0.5, false, true, 0x1234]);
    expect(cpu!.cpuInfo).toBe(0xa4);
    expect(cpu!.names).toEqual(expect.arrayContaining(['%MB200', '%IX0.0.3', '%QW0.1.2']));
  });

  it('an address past the end fails alone even when merged or grouped with good ones', async () => {
    const port = await start();
    const hrefs = ['D1022', 'D1023:DINT', 'D1023', 'T10:BOOL', 'T5000:BOOL', 'Q5', 'D100'];
    reader = await XgtReader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results[0]!.value).toBe(0);
    expect(results[1]!.error).toMatch(/AddressOutOfRange.*0x0004/);
    expect(results[2]!.value).toBe(0);
    expect(results[3]!.value).toBe(true);
    expect(results[4]!.error).toMatch(/0x0004/);
    expect(results[5]!.error).toMatch(/XGK/);
    expect(results[6]!.value).toBe(-2);
  });

  it('reads the error code in its one-byte form too (chapter 8 shows it that way)', async () => {
    const port = await start();
    cpu!.nakOneByte = true;
    reader = await XgtReader.connect(iface(port, ['D5000']), { timeoutMs: 1000 });
    expect((await reader.read(['D5000']))[0]!.error).toMatch(/AddressOutOfRange.*0x0004/);
  });

  it('long runs of addresses stay within 1,400 bytes and 16 blocks per request', async () => {
    const port = await start();
    const hrefs = [...Array.from({ length: 120 }, (_, i) => `D${i * 8}:LREAL`), ...Array.from({ length: 40 }, (_, i) => `C${i}:BOOL`)];
    cpu!.memory.set('D', Buffer.alloc(4096));
    reader = await XgtReader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(cpu!.violations).toEqual([]);
  });

  it('refuses an answer whose invoke id does not match and drops that connection', async () => {
    const port = await start();
    reader = await XgtReader.connect(iface(port, ['D100']), { timeoutMs: 1000 });
    cpu!.wrongInvoke = true;
    expect((await reader.read(['D100']))[0]!.error).toMatch(/XGT/);
    expect((await reader.read(['D100']))[0]!.value).toBe(-2);
    expect(cpu!.connections).toBe(2);
  });

  it('reconnects after the connection drops, and after a timeout drops it', async () => {
    const port = await start();
    reader = await XgtReader.connect(iface(port, ['D100']), { timeoutMs: 300 });
    expect((await reader.read(['D100']))[0]!.value).toBe(-2);
    cpu!.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await reader.read(['D100']))[0]!.value).toBe(-2);
    cpu!.silent = true;
    expect((await reader.read(['D100']))[0]!.error).toBe('Timeout');
    cpu!.silent = false;
    expect((await reader.read(['D100']))[0]!.value).toBe(-2);
    expect(cpu!.connections).toBe(3);
  });

  it('an absent CPU and a bad series are reasons per item, not a stopped collector', async () => {
    const absent = await XgtReader.connect(iface(1, ['D100']), { timeoutMs: 300 });
    expect((await absent.read(['D100']))[0]!.error).toBeTruthy();
    const badSeries = await XgtReader.connect({ ...iface(1, ['D100']), base: 'xgt://127.0.0.1?series=XGZ' });
    expect((await badSeries.read(['D100']))[0]!.error).toMatch(/series/);
  });

  it('builds read requests only — no write instruction (0x0058) exists in the client', () => {
    const source = readFileSync(new URL('../src/xgt-client.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/0x0058|0x5800|0x0059/);
    expect(source).toMatch(/writeUInt16LE\(0x0054, 0\)/);
  });
});
