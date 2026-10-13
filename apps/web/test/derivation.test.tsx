// @vitest-environment jsdom
/**
 * 형식 → 호기 반영 화면 — 파일 요약의 「형식 파일」 카드와 「형식 변경 확인」 창.
 * app.test.tsx 와 같이 fetch 를 진짜 API 핸들러(@aas/api + 인메모리 저장소)에 물려 돌린다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));
type Json = Record<string, unknown>;

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

/** 호기(pkg_1) · 형식(pkg_2) 두 파일. linked 면 호기를 형식에 연결해 둔다 */
async function mount(linked: boolean) {
  const store = new InMemoryStore();
  await store.init();
  await store.importPackage({ name: '01-롤포밍기-1호기.aasx', package: readAasx(goldenBytes) });
  await store.importPackage({ name: '01-롤포밍기-형식.aasx', package: readAasx(goldenBytes) });
  const handle = createApi(store);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = typeof init?.body === 'string' && headers['content-type']?.includes('json') ? (JSON.parse(init.body) as unknown) : undefined;
    const response = await handle({ method: init?.method ?? 'GET', path: url.pathname, query, queryAll: {}, headers, ...(body === undefined ? {} : { body }) } as ApiRequest);
    const payload = response.body instanceof Uint8Array ? response.body : response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(response.status === 204 ? null : (payload as BodyInit | null), { status: response.status, headers: response.headers });
  }) as typeof fetch;
  if (linked) await fetch('/packages/pkg_1/derivation', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourcePackageId: 'pkg_2' }) });
  return store;
}

async function setValue(store: InMemoryStore, packageId: string, idShort: string, value: string): Promise<void> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === 'DigitalNameplate')!;
  (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!['value'] = value;
  await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), submodel);
}

async function valueOf(store: InMemoryStore, packageId: string, idShort: string): Promise<unknown> {
  const environment = await store.getEnvironment(packageId);
  const submodel = (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === 'DigitalNameplate')!;
  return (submodel['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!['value'];
}

const card = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(document.querySelector('.derivation-card')).toBeTruthy());
  return document.querySelector('.derivation-card') as HTMLElement;
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 900, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('형식 → 호기 반영 화면', () => {
  it('형식이 바뀌면 카드가 알리고, 창에서 고른 줄만 반영한다 — 현장에서 고친 줄은 고를 수 없다', async () => {
    const store = await mount(true);
    await setValue(store, 'pkg_1', 'SerialNumber', 'SN-0001'); // 현장 수정
    await setValue(store, 'pkg_2', 'SerialNumber', 'SN-TYPE');
    await setValue(store, 'pkg_2', 'YearOfConstruction', '2027');
    render(<App />);

    const button = await within(await card()).findByRole('button', { name: '형식 변경 확인 (1)' });
    expect(within(await card()).getByText(/이 호기에서 고쳐 그대로 둔 곳 1/)).toBeTruthy();
    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog', { name: '형식 변경 확인' });
    const serial = within(dialog).getByText('SerialNumber').closest('tr') as HTMLElement;
    expect(within(serial).queryByRole('checkbox')).toBeNull();
    expect(within(serial).getByText(/이 호기에서 고친 값/)).toBeTruthy();
    const year = within(dialog).getByText('YearOfConstruction').closest('tr') as HTMLElement;
    expect(within(year).getByText('2027')).toBeTruthy();

    // 고른 것을 모두 풀면 반영 단추가 잠긴다
    fireEvent.click(within(year).getByRole('checkbox'));
    expect((within(dialog).getByRole('button', { name: '고른 0줄 반영' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(year).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '고른 1줄 반영' }));

    expect(await screen.findByText(/형식 변경 1줄을 반영했습니다/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '형식 변경 확인' })).toBeNull());
    expect(await valueOf(store, 'pkg_1', 'YearOfConstruction')).toBe('2027');
    expect(await valueOf(store, 'pkg_1', 'SerialNumber')).toBe('SN-0001');
    await waitFor(async () => expect((await card()).textContent).toMatch(/반영할 형식 변경이 없습니다/));

    // 머리글 「되돌리기」로 되돌리면 값도 돌아오고 카드도 다시 「확인 (1)」을 보인다(2026-10-14 화면에서 잡은 결함)
    const header = document.querySelector('header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: /되돌리기/ }));
    await waitFor(async () => expect(await valueOf(store, 'pkg_1', 'YearOfConstruction')).not.toBe('2027'));
    expect(await within(await card()).findByRole('button', { name: '형식 변경 확인 (1)' })).toBeTruthy();
  });

  it('연결 안 된 호기는 형식 파일을 골라 연결하고, 끊을 때는 한 번 더 묻는다', async () => {
    await mount(false);
    render(<App />);
    fireEvent.click(await within(await card()).findByRole('button', { name: '형식 파일에 연결…' }));
    const link = within(await card()).getByRole('button', { name: '연결' }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.change(within(await card()).getByLabelText('형식 파일'), { target: { value: 'pkg_2' } });
    fireEvent.click(link);
    await waitFor(async () => expect((await card()).textContent).toMatch(/01-롤포밍기-형식\.aasx/));
    expect((await card()).textContent).toMatch(/반영할 형식 변경이 없습니다/);

    fireEvent.click(within(await card()).getByRole('button', { name: '연결 끊기' }));
    expect(within(await card()).getByText(/끊으면 형식 변경을 더 받지 않습니다/)).toBeTruthy();
    fireEvent.click(within(await card()).getByRole('button', { name: '끊기' }));
    expect(await within(await card()).findByRole('button', { name: '형식 파일에 연결…' })).toBeTruthy();
  });

  it('형식 파일이 지워지면 반영 단추 대신 그 사실을 말한다', async () => {
    const store = await mount(true);
    await store.deletePackage('pkg_2');
    render(<App />);
    expect(await within(await card()).findByText(/보관함에 없습니다/)).toBeTruthy();
    expect(within(await card()).queryByRole('button', { name: /형식 변경 확인/ })).toBeNull();
  });
});
