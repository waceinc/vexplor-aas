/**
 * MC protocol 3E binary (VEXPLOR extension binding) — address grammar, batching and reading against the test CPU
 * (mc-mock-server.ts). No real PLC is involved: these tests pin the frames to the published format, not to a measured CPU.
 */
import { mcAddress, mcEndpoint, type AidInterface, type McAddress } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { McReader, planMcBlocks } from '../src/index.js';
import { McMockServer } from './mc-mock-server.js';

const D = 0xa8;
const W = 0xb4;
const R = 0xaf;
const M = 0x90;
const X = 0x9c;

describe('MC address grammar', () => {
  it('endpoint — the port is required; series Q by default, iQ-R and iQ-F by name', () => {
    expect(mcEndpoint('melsec://10.0.0.7:5000')).toEqual({ host: '10.0.0.7', port: 5000, series: 'Q', network: 0, station: 255 });
    expect(mcEndpoint('melsec://10.0.0.7:5002?series=iQ-F').series).toBe('iQ-F');
    expect(mcEndpoint('melsec://10.0.0.7:5002?series=iq-r').series).toBe('iQ-R');
    expect(() => mcEndpoint('melsec://10.0.0.7')).toThrow(/포트/);
    expect(() => mcEndpoint('melsec://10.0.0.7:5000?series=Z')).toThrow(/series/);
  });

  it('decimal D · M · R, hexadecimal X · Y · W, octal X · Y on iQ-F; word bits and types', () => {
    expect(mcAddress('D100')).toMatchObject({ device: 'D', number: 100, type: 'INT', points: 1, bitDevice: false });
    expect(mcAddress('D200:REAL')).toMatchObject({ type: 'REAL', points: 2 });
    expect(mcAddress('D300:LREAL')).toMatchObject({ points: 4 });
    expect(mcAddress('D10.3')).toMatchObject({ number: 10, bit: 3, type: 'BOOL' });
    expect(mcAddress('D10.F')).toMatchObject({ bit: 15 });
    expect(mcAddress('X1F')).toMatchObject({ number: 31, bitDevice: true, type: 'BOOL' });
    expect(mcAddress('X17', 'iQ-F')).toMatchObject({ number: 15 });
    expect(mcAddress('W1A:DINT')).toMatchObject({ number: 26, points: 2 });
    expect(mcAddress('R0:STRING[10]')).toMatchObject({ type: 'STRING', length: 10, points: 5 });
  });

  it('rejects malformed addresses, digits outside the radix and types a device cannot hold', () => {
    for (const bad of ['D', 'DA', 'Z10', 'M10.1', 'M10:INT', 'D10:BYTE', 'D10.3:INT', 'D10.G', 'D1:FOO']) expect(() => mcAddress(bad), bad).toThrow();
    expect(() => mcAddress('X18', 'iQ-F')).toThrow();
  });

  it('merges neighbours on the same device and unit, within the point limits', () => {
    const addresses: McAddress[] = ['D100', 'D101', 'D110:DINT', 'D2000', 'M0', 'M5', 'W0'].map((a) => mcAddress(a));
    const blocks = planMcBlocks(addresses);
    expect(blocks.map((b) => [b.code, b.start, b.points, b.members.length])).toEqual([
      [D, 100, 12, 3],
      [D, 2000, 1, 1],
      [M, 0, 6, 2],
      [W, 0, 1, 1],
    ]);
    const far = planMcBlocks([mcAddress('D0'), mcAddress('D959'), mcAddress('D960')]);
    expect(far.every((b) => b.points <= 960)).toBe(true);
  });
});

describe('MC collection — reads against the test CPU', () => {
  let cpu: McMockServer | undefined;
  let reader: McReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await cpu?.close();
    reader = undefined;
  });

  const iface = (port: number, hrefs: string[], query = ''): AidInterface => ({
    name: 'InterfaceTemplateForMC',
    protocol: 'MC',
    base: `melsec://127.0.0.1:${port}${query}`,
    properties: hrefs.map((href, i) => ({ name: `T${i}`, href, observable: true, formFields: {} })),
  });

  async function start(): Promise<number> {
    cpu = new McMockServer(1024);
    const le = (write: (b: Buffer) => void, size: number): Buffer => {
      const b = Buffer.alloc(size);
      write(b);
      return b;
    };
    cpu.setBytes(D, 100, le((b) => b.writeInt16LE(-2), 2));
    cpu.setBytes(D, 101, le((b) => b.writeUInt16LE(0xbeef), 2));
    cpu.setBytes(D, 102, le((b) => b.writeFloatLE(12.5), 4));
    cpu.setBytes(D, 104, le((b) => b.writeInt32LE(-100000), 4));
    cpu.setBytes(D, 106, le((b) => b.writeDoubleLE(1.25), 8));
    cpu.setBytes(D, 10, le((b) => b.writeUInt16LE(0b1000), 2));
    cpu.setBytes(W, 0x1a, le((b) => b.writeInt32LE(70000), 4));
    cpu.setBytes(R, 0, Buffer.from('PRESS\0\0\0\0\0', 'latin1'));
    cpu.memory.get(M)![50] = 1;
    cpu.memory.get(X)![0x1f] = 1;
    cpu.memory.get(X)![15] = 1;
    return cpu.listen();
  }

  it('reads word values little-endian (low word first), word bits, bit devices and strings in few requests', async () => {
    const port = await start();
    const hrefs = ['D100', 'D101:UINT', 'D102:REAL', 'D104:DINT', 'D106:LREAL', 'D10.3', 'D10.2', 'W1A:DINT', 'R0:STRING[10]', 'M50', 'M51', 'X1F'];
    reader = await McReader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results.map((r) => r.value)).toEqual([-2, 0xbeef, 12.5, -100000, 1.25, true, false, 70000, 'PRESS', true, false, true]);
    expect(results.every((r) => r.quality === 'Good')).toBe(true);
    // D10 · D100–D107 (one merged block) · W · R · M50–M51 · X
    expect(cpu!.requests).toBe(6);
  });

  it('numbers X in octal on iQ-F — X17 is the 16th input', async () => {
    const port = await start();
    reader = await McReader.connect(iface(port, ['X17'], '?series=iQ-F'), { timeoutMs: 1000 });
    expect((await reader.read(['X17']))[0]!.value).toBe(true);
  });

  it('an address past the end of the device fails alone even when it was merged with good ones', async () => {
    const port = await start();
    const hrefs = ['D1020', 'D1023:DINT', 'D1022', 'Q5', 'D100'];
    reader = await McReader.connect(iface(port, hrefs), { timeoutMs: 1000 });
    const results = await reader.read(hrefs);
    expect(results[0]!.value).toBe(0);
    expect(results[1]!.error).toMatch(/AddressOutOfRange.*C056/);
    expect(results[2]!.value).toBe(0);
    expect(results[3]!.error).toMatch(/MC/);
    expect(results[4]!.value).toBe(-2);
  });

  it('reconnects after the connection drops, and after a timeout drops it', async () => {
    const port = await start();
    reader = await McReader.connect(iface(port, ['D100']), { timeoutMs: 300 });
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

  it('an absent CPU and a missing port are reasons per item, not a stopped collector', async () => {
    const absent = await McReader.connect(iface(1, ['D100']), { timeoutMs: 300 });
    expect((await absent.read(['D100']))[0]!.error).toBeTruthy();
    const noPort = await McReader.connect({ ...iface(1, ['D100']), base: 'melsec://127.0.0.1' });
    expect((await noPort.read(['D100']))[0]!.error).toMatch(/포트/);
  });
});
