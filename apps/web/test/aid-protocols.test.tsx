// @vitest-environment jsdom
/**
 * 수집 연결 만들기 — Modbus TCP · MQTT. 주소로 프로토콜을 알아보고, Modbus 는 줄마다 레지스터 종류 · 자료형을 고른다.
 * 40001 같은 관례 주소는 종류와 0 기준 주소로 바꿔 준다. 만든 AID 는 서버가 도로 읽는 모양이어야 한다.
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

describe('수집 연결 — 프로토콜 판정 · 관례 주소', () => {
  it('접속 주소로 프로토콜을 정한다', () => {
    expect(protocolOfEndpoint('opc.tcp://h:4840')).toBe('OPCUA');
    expect(protocolOfEndpoint('modbus+tcp://h:502/1')).toBe('MODBUS');
    expect(protocolOfEndpoint('mqtts://broker')).toBe('MQTT');
    expect(protocolOfEndpoint('http://h')).toBeUndefined();
  });
  it('관례 주소 — 앞자리가 종류, 나머지 - 1 이 주소', () => {
    expect(fromModiconAddress('40001')).toEqual({ entity: 'HoldingRegister', address: 0 });
    expect(fromModiconAddress('30010')).toEqual({ entity: 'InputRegister', address: 9 });
    expect(fromModiconAddress('00005')).toEqual({ entity: 'Coil', address: 4 });
    expect(fromModiconAddress('100003')).toEqual({ entity: 'DiscreteInput', address: 2 });
    expect(fromModiconAddress('40')).toBeUndefined();
    expect(fromModiconAddress('20001')).toBeUndefined();
    expect(fromModiconAddress('40000')).toBeUndefined();
  });
});

describe('수집 연결 만들기 — Modbus', () => {
  it('설비에서 불러오기는 잠기고, 손으로 적은 줄의 종류 · 자료형이 AID 폼 항목으로 들어간다', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'))) });
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
    // 관례 주소 → 입력 레지스터 9번
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
