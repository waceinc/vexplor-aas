// @vitest-environment jsdom
/**
 * Create collection link — what the screen can now state (2.8.0): an MQTT or OPC UA login without a password in the
 * file, OPC UA security, units, Modbus word and byte order, and a read period. "Edit link" starts from the link that
 * is there. Every check reads the AID the server stored, the way the collector will read it.
 */
import { readAasx } from '@aas/aasx';
import { parseAid } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { InterfaceCard } from '../src/components/collection/InterfaceCard.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

async function openDialog(options: Parameters<typeof wireFetch>[1] = {}) {
  const store = new InMemoryStore();
  await store.init();
  await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
  wireFetch(store, options);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));
  const dialog = await screen.findByRole('dialog', { name: '수집 연결 만들기' });
  return { store, dialog };
}

const stored = async (store: InMemoryStore) => parseAid(await store.getEnvironment('pkg_1'))[0]!;

function addRow(dialog: HTMLElement, name: string, href: string): void {
  fireEvent.click(within(dialog).getByRole('button', { name: '+ 손으로 입력' }));
  const index = within(dialog).getAllByLabelText(/^태그 \d+ 이름$/).length;
  fireEvent.change(within(dialog).getByLabelText(`태그 ${index} 이름`), { target: { value: name } });
  fireEvent.change(within(dialog).getByLabelText(`태그 ${index} 주소`), { target: { value: href } });
}

describe('MQTT login without a password in the file', () => {
  it('a password in the address is shown masked, locks "Create", and one button moves it out and turns on the login', async () => {
    const { store, dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'mqtt://aas:secret@broker.local:1883' } });
    expect(within(dialog).getByText(/주소에 사용자 이름 · 암호가 들어 있습니다/)).toBeTruthy();
    expect(within(dialog).queryByText(/aas:secret/)).toBeNull();
    addRow(dialog, 'Temperature', 'plant/m1/temp');
    expect((within(dialog).getByRole('button', { name: /^만들기/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '주소에서 떼고 로그인 필요 켜기' }));
    expect((within(dialog).getByLabelText('접속 주소') as HTMLInputElement).value).toBe('mqtt://broker.local:1883');
    expect((within(dialog).getByLabelText('로그인 필요') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /^만들기/ }));
    await screen.findByText(/수집 연결을 만들었습니다/);
    const aid = await stored(store);
    expect(aid.base).toBe('mqtt://broker.local:1883');
    expect(aid.security).toEqual({ userIdentityToken: 'UserName' });
    expect(JSON.stringify(await store.getEnvironment('pkg_1'))).not.toContain('secret');
  });

  it('the collection card never shows the password of an old link, and says why it is left out', () => {
    render(
      <InterfaceCard
        descriptor={{ name: 'MQTT', protocol: 'MQTT', base: 'mqtt://aas:secret@broker.local:1883', properties: [{ name: 'T', href: 'a/b', observable: true }] }}
        status={{ kind: 'idle', label: '수집 전' }}
        latest={new Map()}
        waitingTags={new Set()}
        failedTags={new Map()}
        nowMs={0}
        windowMs={300_000}
      />,
    );
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.getByText('mqtt://***@broker.local:1883')).toBeTruthy();
    expect(screen.getByText(/원격 수집기 목록에서 빠집니다/)).toBeTruthy();
  });
});

describe('OPC UA security on the screen', () => {
  it('mode, policy and login go into the AID, and "Load from equipment" connects with them', async () => {
    const seen: unknown[] = [];
    const { store, dialog } = await openDialog({
      browseDevice: async (endpoint: string, options?: unknown) => (seen.push(options), { endpoint, truncated: false, nodes: [{ nodeId: 'ns=1;s=Machine.MotorSpeed', name: 'MotorSpeed', path: 'Machine/MotorSpeed', type: 'float' }] }),
    } as never);
    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'opc.tcp://192.168.0.50:4840' } });
    fireEvent.change(within(dialog).getByLabelText('보안 방식'), { target: { value: 'SignAndEncrypt' } });
    fireEvent.change(within(dialog).getByLabelText('보안 정책'), { target: { value: 'Aes256_Sha256_RsaPss' } });
    fireEvent.click(within(dialog).getByLabelText('로그인 필요'));
    fireEvent.click(within(dialog).getByRole('button', { name: '설비에서 불러오기' }));
    await waitFor(() => expect(seen).toEqual([{ security: { mode: 'SignAndEncrypt', policy: 'Aes256_Sha256_RsaPss', login: true } }]));
    fireEvent.click(await within(dialog).findByLabelText(/MotorSpeed/));
    fireEvent.click(within(dialog).getByRole('button', { name: /담기/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^만들기/ }));
    await screen.findByText(/수집 연결을 만들었습니다/);
    expect((await stored(store)).security).toEqual({ mode: 'SignAndEncrypt', policy: 'Aes256_Sha256_RsaPss', userIdentityToken: 'UserName' });
  });
});

describe('units, Modbus order and read period — and "Edit link" starts from them', () => {
  it('writes them into the AID, then the edit dialog opens filled in', async () => {
    const { store, dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'modbus+tcp://192.168.0.20:502/1' } });
    addRow(dialog, 'Flow', '40');
    fireEvent.change(within(dialog).getByLabelText('태그 1 자료형'), { target: { value: 'xsd:float' } });
    fireEvent.change(within(dialog).getByLabelText('태그 1 바이트 · 워드 순서'), { target: { value: 'CDAB' } });
    fireEvent.change(within(dialog).getByLabelText('태그 1 단위'), { target: { value: 'L/min' } });
    fireEvent.change(within(dialog).getByLabelText('읽기 주기(초)'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^만들기/ }));
    await screen.findByText(/수집 연결을 만들었습니다/);
    const flow = (await stored(store)).properties[0]!;
    expect(flow.unit).toBe('L/min');
    expect(flow.formFields).toMatchObject({ modv_type: 'xsd:float', modv_mostSignificantWord: 'false', modv_mostSignificantByte: 'true', modv_pollingTime: '2000' });

    fireEvent.click(await screen.findByRole('button', { name: '연결수정' }));
    const edit = await screen.findByRole('dialog', { name: '수집 연결 만들기' });
    await waitFor(() => expect((within(edit).getByLabelText('접속 주소') as HTMLInputElement).value).toBe('modbus+tcp://192.168.0.20:502/1'));
    expect((within(edit).getByLabelText('태그 1 이름') as HTMLInputElement).value).toBe('Flow');
    expect((within(edit).getByLabelText('태그 1 단위') as HTMLInputElement).value).toBe('L/min');
    expect((within(edit).getByLabelText('태그 1 바이트 · 워드 순서') as HTMLSelectElement).value).toBe('CDAB');
    expect((within(edit).getByLabelText('읽기 주기(초)') as HTMLInputElement).value).toBe('2');
  });

  it('an impossible read period is said on the screen and locks "Create"', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('접속 주소'), { target: { value: 'opc.tcp://192.168.0.50:4840' } });
    addRow(dialog, 'Speed', 'ns=1;s=Speed');
    fireEvent.change(within(dialog).getByLabelText('읽기 주기(초)'), { target: { value: '0.01' } });
    expect(within(dialog).getByText(/읽기 주기는 0.1 ~ 3600초/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: /^만들기/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
