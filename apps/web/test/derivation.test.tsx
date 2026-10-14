// @vitest-environment jsdom
/**
 * Type -> unit propagation screen: the "type file" card in the file summary and the "confirm type changes" dialog.
 * Like app.test.tsx, runs with fetch wired to the real API handler (@aas/api + in-memory store).
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { useScreenHarness, wireFetch } from './harness.js';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
type Json = Record<string, unknown>;

/** Two files: unit (pkg_1) and type (pkg_2). When linked, the unit is linked to the type */
async function mount(linked: boolean) {
  const store = new InMemoryStore();
  await store.init();
  await store.importPackage({ name: '01-롤포밍기-1호기.aasx', package: readAasx(goldenBytes) });
  await store.importPackage({ name: '01-롤포밍기-형식.aasx', package: readAasx(goldenBytes) });
  wireFetch(store);
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

useScreenHarness();

describe('type -> unit propagation screen', () => {
  it('the card notices a type change and the dialog applies only the chosen rows (rows edited on site cannot be chosen)', async () => {
    const store = await mount(true);
    await setValue(store, 'pkg_1', 'SerialNumber', 'SN-0001'); // on-site edit
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

    // unchecking everything locks the apply button
    fireEvent.click(within(year).getByRole('checkbox'));
    expect((within(dialog).getByRole('button', { name: '고른 0줄 반영' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(year).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '고른 1줄 반영' }));

    expect(await screen.findByText(/형식 변경 1줄을 반영했습니다/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '형식 변경 확인' })).toBeNull());
    expect(await valueOf(store, 'pkg_1', 'YearOfConstruction')).toBe('2027');
    expect(await valueOf(store, 'pkg_1', 'SerialNumber')).toBe('SN-0001');
    await waitFor(async () => expect((await card()).textContent).toMatch(/반영할 형식 변경이 없습니다/));

    // reverting via the header "Revert" restores the value and the card again shows "Confirm (1)" (defect caught on screen, 2026-10-14)
    const header = document.querySelector('header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: /되돌리기/ }));
    await waitFor(async () => expect(await valueOf(store, 'pkg_1', 'YearOfConstruction')).not.toBe('2027'));
    expect(await within(await card()).findByRole('button', { name: '형식 변경 확인 (1)' })).toBeTruthy();
  });

  it('an unlinked unit picks a type file to link, and unlinking asks once more', async () => {
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

  it('when the type file is deleted, says so instead of showing the apply button', async () => {
    const store = await mount(true);
    await store.deletePackage('pkg_2');
    render(<App />);
    expect(await within(await card()).findByText(/보관함에 없습니다/)).toBeTruthy();
    expect(within(await card()).queryByRole('button', { name: /형식 변경 확인/ })).toBeNull();
  });
});
