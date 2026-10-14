// @vitest-environment jsdom
/**
 * Fill-from-CSV screen: the value table's "Fill from CSV..." fills nameplate values across several equipment files at once.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

type Json = Record<string, unknown>;
const bytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

/** Two of the same equipment, with AAS idShort RFM_A and RFM_B */
async function mount(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.init();
  for (const name of ['RFM_A', 'RFM_B']) {
    const pkg = readAasx(bytes);
    pkg.environment.assetAdministrationShells![0]!.idShort = name;
    await store.importPackage({ name: `${name}.aasx`, package: pkg });
  }
  wireFetch(store);
  return store;
}

async function nameplateValue(store: InMemoryStore, packageId: string, idShort: string): Promise<unknown> {
  const env = await store.getEnvironment(packageId);
  const sm = (env.submodels as unknown as Json[]).find((s) => s['idShort'] === 'DigitalNameplate')!;
  return (sm['submodelElements'] as Json[]).find((e) => e['idShort'] === idShort)!['value'];
}

describe('fill from CSV', () => {
  it('pasting a register preselects columns and both files change as previewed (empty cells do not clear)', async () => {
    const store = await mount();
    const serialBefore = await nameplateValue(store, 'pkg_2', 'SerialNumber');
    render(<App />);
    fireEvent.click(await screen.findByText('DigitalNameplate'));
    const table = (await screen.findByText(/값 한꺼번에 입력/)).closest('.bulk-values') as HTMLElement;
    fireEvent.click(within(table).getByRole('button', { name: 'CSV에서 채우기…' }));

    const dialog = await screen.findByRole('dialog', { name: 'CSV에서 채우기' });
    fireEvent.change(within(dialog).getByLabelText('CSV 내용'), {
      target: { value: 'Name,SerialNumber,Year Of Construction,Memo\nRFM_A,SN-A-001,2031,x\nRFM_B,,2032,y\nGhost,SN-9,2033,z\n' },
    });
    // columns with matching names are preselected; a name with no match (Memo) is "do not import"
    expect((within(dialog).getByLabelText('SerialNumber 열을 넣을 항목') as HTMLSelectElement).value).toBe('SerialNumber');
    expect((within(dialog).getByLabelText('Year Of Construction 열을 넣을 항목') as HTMLSelectElement).value).toBe('YearOfConstruction');
    expect((within(dialog).getByLabelText('Memo 열을 넣을 항목') as HTMLSelectElement).value).toBe('');

    await within(dialog).findByText(/미리 보기 — 파일 2개 · 값 3개가 바뀝니다/);
    expect(within(dialog).getByText(/같은 이름의 파일이 없습니다/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '파일 2개에 값 3개 반영' }));

    expect(await screen.findByText(/CSV 값 3개를 파일 2개에 반영했습니다/)).toBeTruthy();
    expect(await nameplateValue(store, 'pkg_1', 'SerialNumber')).toBe('SN-A-001');
    expect(await nameplateValue(store, 'pkg_1', 'YearOfConstruction')).toBe('2031');
    expect(await nameplateValue(store, 'pkg_2', 'YearOfConstruction')).toBe('2032');
    expect(await nameplateValue(store, 'pkg_2', 'SerialNumber')).toBe(serialBefore); // empty cell leaves it unchanged
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'CSV에서 채우기' })).toBeNull());
  });
});
