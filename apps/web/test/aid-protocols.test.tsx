// @vitest-environment jsdom
/**
 * Create collection connection: Modbus TCP and MQTT. Detects the protocol from the address; for Modbus, each row picks a register type and data type.
 * Conventional addresses such as 40001 are converted to a type plus a zero-based address. The generated AID must be in the shape the server reads back.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { fromModiconAddress, protocolOfEndpoint } from '../src/components/aid/protocol.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

describe('collection connection: protocol detection and conventional addresses', () => {
  it('decides the protocol from the endpoint address', () => {
    expect(protocolOfEndpoint('opc.tcp://h:4840')).toBe('OPCUA');
    expect(protocolOfEndpoint('modbus+tcp://h:502/1')).toBe('MODBUS');
    expect(protocolOfEndpoint('mqtts://broker')).toBe('MQTT');
    expect(protocolOfEndpoint('http://h')).toBeUndefined();
  });
  it('conventional address: leading digit is the type, the rest minus 1 is the address', () => {
    expect(fromModiconAddress('40001')).toEqual({ entity: 'HoldingRegister', address: 0 });
    expect(fromModiconAddress('30010')).toEqual({ entity: 'InputRegister', address: 9 });
    expect(fromModiconAddress('00005')).toEqual({ entity: 'Coil', address: 4 });
    expect(fromModiconAddress('100003')).toEqual({ entity: 'DiscreteInput', address: 2 });
    expect(fromModiconAddress('40')).toBeUndefined();
    expect(fromModiconAddress('20001')).toBeUndefined();
    expect(fromModiconAddress('40000')).toBeUndefined();
  });
});

describe('create collection connection: Modbus', () => {
  it('import from equipment is locked, and the type and data type of manually entered rows go into the AID form fields', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
    wireFetch(store);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));
    const dialog = await screen.findByRole('dialog', { name: '수집 연결 만들기' });

    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'modbus+tcp://192.168.0.20:502/1' } });
    expect((within(dialog).getByRole('button', { name: '설비에서 불러오기' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Modbus TCP 는 설비에서 불러오기가 없습니다/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '+ 손으로 입력' }));
    fireEvent.change(within(dialog).getByLabelText('태그 1 이름'), { target: { value: 'Counter' } });
    fireEvent.change(within(dialog).getByLabelText('태그 1 주소'), { target: { value: '30010' } });
    // conventional address -> input register 9
    fireEvent.click(within(dialog).getByRole('button', { name: /30010 → 입력 레지스터 9번/ }));
    expect((within(dialog).getByLabelText('태그 1 주소') as HTMLInputElement).value).toBe('9');
    expect((within(dialog).getByLabelText('태그 1 레지스터 종류') as HTMLSelectElement).value).toBe('InputRegister');
    fireEvent.change(within(dialog).getByLabelText('태그 1 자료형'), { target: { value: 'xsd:float' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^만들기/ }));

    await screen.findByText(/수집 연결을 만들었습니다/);
    const res = await (await fetch('/packages/pkg_1/interfaces')).json() as { interfaces: { name: string; protocol: string; base: string; properties: { name: string; href: string; type: string }[] }[] };
    await waitFor(() => expect(res.interfaces[0]).toMatchObject({ name: 'InterfaceTemplateForModbus', protocol: 'MODBUS', base: 'modbus+tcp://192.168.0.20:502/1' }));
    expect(res.interfaces[0]!.properties[0]).toMatchObject({ name: 'Counter', href: '9', type: 'float' });
    const env = JSON.stringify(await store.getEnvironment('pkg_1'));
    expect(env).toContain('"idShort":"modv_entity","semanticId"');
    expect(env).toContain('"value":"InputRegister"');
    expect(env).toContain('"value":"xsd:float"');
  });
});

describe('tag pattern', () => {
  it('{n} is the number, {i} the ordinal, {n:2} zero-padded; respects step and range', async () => {
    const { expandPattern } = await import('../src/components/aid/pattern.js');
    expect(expandPattern({ name: 'Zone{i}_Temp', href: 'ns=1;s=Zone{n:2}.Temp', from: 1, to: 3, step: 1 }).rows).toEqual([
      { name: 'Zone1_Temp', href: 'ns=1;s=Zone01.Temp' },
      { name: 'Zone2_Temp', href: 'ns=1;s=Zone02.Temp' },
      { name: 'Zone3_Temp', href: 'ns=1;s=Zone03.Temp' },
    ]);
    expect(expandPattern({ name: 'Temp_{i}', href: '{n}', from: 100, to: 106, step: 2 }).rows.map((row) => row.href)).toEqual(['100', '102', '104', '106']);
    expect(expandPattern({ name: 'Fixed', href: '{n}', from: 1, to: 2, step: 1 }).problem).toBe('name');
    expect(expandPattern({ name: 'T{n}', href: '{n}', from: 5, to: 1, step: 1 }).problem).toBe('range');
    expect(expandPattern({ name: 'T{n}', href: '{n}', from: 1, to: 9999, step: 1 }).problem).toBe('too-many');
  });

  it('adding by pattern in the dialog creates that many rows', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
    wireFetch(store);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));
    const dialog = await screen.findByRole('dialog', { name: '수집 연결 만들기' });
    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'modbus+tcp://10.0.0.5/1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '+ 패턴으로 여러 개' }));
    fireEvent.change(within(dialog).getByLabelText('이름 틀'), { target: { value: 'Temp_{i}' } });
    fireEvent.change(within(dialog).getByLabelText('끝'), { target: { value: '6' } });
    fireEvent.change(within(dialog).getByLabelText('간격'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '3개 담기' }));
    expect((within(dialog).getByLabelText('태그 3 이름') as HTMLInputElement).value).toBe('Temp_3');
    expect((within(dialog).getByLabelText('태그 3 주소') as HTMLInputElement).value).toBe('5');
    expect((within(dialog).getByLabelText('태그 3 레지스터 종류') as HTMLSelectElement).value).toBe('HoldingRegister');
  });
});
