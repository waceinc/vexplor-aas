// @vitest-environment jsdom
/**
 * Create collection link: S7 and MC (VEXPLOR extension bindings). The screen's address check must agree with the
 * server grammar (@aas/collector plc-address.ts) — both run over one list here — and "Create" must join address and
 * data type into the href the server reads back.
 */
import { readAasx } from '@aas/aasx';
import { mcAddress, mcEndpoint, s7Address } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { plcHrefOf, plcHrefOk, plcWotType, splitPlcHref } from '../src/components/aid/plc.js';
import { protocolOfEndpoint } from '../src/components/aid/protocol.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

const S7_SAMPLES = ['DB10.DBD4:REAL', 'DB1.DBX0.3', 'db1.dbx0.8', 'DB0.DBW0', 'M10.3', 'M10', 'MW20:INT', 'MW20.1', 'IB0', 'EB0', 'QX1.7', 'DB2.DBB0:STRING[20]', 'DB2.DBB0:STRING[300]', 'DB2.DBD8:LREAL', 'DB1.DBW0:REAL', 'MD4:INT', 'MW0:STRING', 'MB0:STRING', 'DB1.DBW0:FOO', 'DB1.DBW0:INT:X', 'T5', 'DB1.DBW0:INT16', 'MD0:FLOAT'];
const MC_SAMPLES = ['D100', 'D200:REAL', 'D10.3', 'D10.F', 'D10.G', 'M50', 'M10.1', 'M10:INT', 'X1F', 'X17', 'X18', 'Y7', 'W1A:DINT', 'R0:STRING[10]', 'D10:BYTE', 'D10.3:INT', 'D10.3:BOOL', 'Z10', 'D', 'DA', 'D1:FOO', 'D5:DOUBLE'];

const serverAccepts = (check: () => unknown): boolean => {
  try {
    check();
    return true;
  } catch {
    return false;
  }
};

describe('S7 · MC address check on the screen agrees with the server grammar', () => {
  it('decides the protocol from the endpoint', () => {
    expect(protocolOfEndpoint('s7://10.0.0.5?rack=0&slot=1')).toBe('S7');
    expect(protocolOfEndpoint('melsec://10.0.0.7:5000')).toBe('MC');
  });

  it('S7 — every sample is judged the same way', () => {
    for (const href of S7_SAMPLES) expect(plcHrefOk('S7', 's7://h', href), href).toBe(serverAccepts(() => s7Address(href)));
  });

  it('MC — every sample is judged the same way, on Q and on iQ-F numbering', () => {
    for (const endpoint of ['melsec://h:5000', 'melsec://h:5000?series=iQ-F']) {
      const series = mcEndpoint(endpoint).series;
      for (const href of MC_SAMPLES) expect(plcHrefOk('MC', endpoint, href), `${endpoint} ${href}`).toBe(serverAccepts(() => mcAddress(href, series)));
    }
  });

  it('joins and splits address and type; the AID type follows the PLC type or the address default', () => {
    expect(plcHrefOf('DB10.DBD4', 'REAL')).toBe('DB10.DBD4:REAL');
    expect(plcHrefOf('M10.3', '')).toBe('M10.3');
    expect(plcHrefOf('DB2.DBB0:STRING[20]', 'INT')).toBe('DB2.DBB0:STRING[20]');
    expect(splitPlcHref('S7', 'DB10.DBD4:REAL')).toEqual({ address: 'DB10.DBD4', plcType: 'REAL' });
    expect(splitPlcHref('S7', 'DB2.DBB0:STRING[20]')).toEqual({ address: 'DB2.DBB0:STRING[20]', plcType: '' });
    expect([plcWotType('S7', 'M10.3'), plcWotType('S7', 'MW20'), plcWotType('MC', 'D200:REAL'), plcWotType('MC', 'X1F'), plcWotType('MC', 'D10.3')]).toEqual(['boolean', 'integer', 'float', 'boolean', 'boolean']);
  });
});

describe('create collection link: S7', () => {
  it('no load from equipment; an address the server would refuse is marked; "Create" stores address and type as one href', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
    wireFetch(store);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));
    const dialog = await screen.findByRole('dialog', { name: '수집 연결 만들기' });

    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 's7://192.168.0.10?rack=0&slot=1' } });
    expect((within(dialog).getByRole('button', { name: '설비에서 불러오기' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/VEXPLOR 확장 표기/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '+ 손으로 입력' }));
    fireEvent.change(within(dialog).getByLabelText('태그 1 이름'), { target: { value: 'Speed' } });
    const address = within(dialog).getByLabelText('태그 1 주소') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'DB10.DBW4' } });
    fireEvent.change(within(dialog).getByLabelText('태그 1 PLC 자료형'), { target: { value: 'REAL' } });
    // DBW is two bytes — REAL needs DBD
    expect(address.classList.contains('miss')).toBe(true);
    fireEvent.change(address, { target: { value: 'DB10.DBD4' } });
    expect(address.classList.contains('miss')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: /^만들기/ }));

    await screen.findByText(/수집 연결을 만들었습니다/);
    const res = (await (await fetch('/packages/pkg_1/interfaces')).json()) as { interfaces: { name: string; protocol: string; properties: { name: string; href: string; type: string }[] }[] };
    await waitFor(() => expect(res.interfaces[0]).toMatchObject({ name: 'InterfaceTemplateForS7', protocol: 'S7' }));
    expect(res.interfaces[0]!.properties[0]).toMatchObject({ name: 'Speed', href: 'DB10.DBD4:REAL', type: 'float' });
  });
});
