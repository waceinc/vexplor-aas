// @vitest-environment jsdom
/**
 * Line level screen: "+ Line" on the company row, "+ Process" on the line row, then "+ Equipment". Both immediate mode (after creation) and draft (new).
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

interface TreeNode {
  name: string;
  line?: boolean;
  globalAssetId: string;
  children: TreeNode[];
}

async function tree(packageId: string): Promise<TreeNode[]> {
  return ((await (await fetch(`/packages/${packageId}/hierarchy`)).json()) as { children: TreeNode[] }).children;
}

/** Type a name into the input row and press Enter */
function typeName(label: RegExp, name: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('line level screen', () => {
  it('in a created company file, + Line then + Process on the line row: the file records line -> process and the summary shows the line count', async () => {
    const store = new InMemoryStore();
    await store.init();
    wireFetch(store);
    await fetch('/packages/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetName: 'WaceFactory', unit: 'composite' }) });
    render(<App />);

    const panel = (await screen.findByText('공정·설비 구성')).closest('.hierarchy') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: '＋ 라인' }));
    typeName(/^라인 이름$/, 'BodyLine');
    await waitFor(async () => expect((await tree('pkg_1'))[0]).toMatchObject({ name: 'BodyLine', line: true }));

    // the line row gets "+ Process"; the process row does not
    const lineRow = (await within(panel).findByText('BodyLine')).closest('.build-row') as HTMLElement;
    fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 공정' }));
    typeName(/^공정 이름$/, 'WeldingProcess');
    await waitFor(async () => expect((await tree('pkg_1'))[0]!.children[0]).toMatchObject({ name: 'WeldingProcess', line: false }));
    const processRow = (await within(panel).findByText('WeldingProcess')).closest('.build-row') as HTMLElement;
    expect(within(processRow).queryByRole('button', { name: '＋ 공정' })).toBeNull();
    expect(within(processRow).getByRole('button', { name: '＋ 설비' })).toBeTruthy();

    // summary tile shows line 1, counted separately from processes and groups
    const tiles = document.querySelector('.summary .tiles') as HTMLElement;
    await waitFor(() => expect(within(tiles).getByText('라인').previousElementSibling?.textContent).toBe('1'));
    expect(within(tiles).getByText('공정·그룹').previousElementSibling?.textContent).toBe('1');
  });

  it('new (draft) mode also creates line -> process -> name-only equipment as is', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: '01-롤포밍기.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'))) });
    wireFetch(store);
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const header = document.querySelector('header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: /^파일/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /새로 만들기/ }));

    const form = (await screen.findByText('새로 만들기', { selector: 'h3' })).closest('.add-form') as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(within(form).getByLabelText(/① 이름/), { target: { value: 'DraftFactory' } });
    fireEvent.click(within(form).getByRole('button', { name: '＋ 라인' }));
    typeName(/^라인 이름$/, 'PaintLine');
    const lineRow = within(form).getByText('PaintLine').closest('.build-row') as HTMLElement;
    fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 공정' }));
    typeName(/^공정 이름$/, 'CoatProcess');
    const processRow = within(form).getByText('CoatProcess').closest('.build-row') as HTMLElement;
    fireEvent.click(within(processRow).getByRole('button', { name: '＋ 설비' }));
    const nameOnly = await within(form).findByPlaceholderText(/이름만/);
    fireEvent.change(nameOnly, { target: { value: 'SprayRobot' } });
    fireEvent.keyDown(nameOnly, { key: 'Enter' });
    fireEvent.click(within(form).getByRole('button', { name: /^만들기/ }));

    await waitFor(async () => {
      const made = (await tree('pkg_2'))[0];
      expect(made).toMatchObject({ name: 'PaintLine', line: true });
      expect(made!.children[0]).toMatchObject({ name: 'CoatProcess', line: false });
      expect(made!.children[0]!.children[0]!.name).toBe('SprayRobot');
    });
  });

  it('switching the open input row does not freeze the screen, even in browsers where scrollIntoView returns a Promise', async () => {
    // like recent Chrome, returns a Promise. When the effect returned it, React called it as a cleanup function and the whole screen froze (2026-10-14)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => Promise.resolve(), configurable: true });
    try {
      const store = new InMemoryStore();
      await store.init();
      wireFetch(store);
      await fetch('/packages/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetName: 'WaceFactory', unit: 'composite' }) });
      render(<App />);
      const panel = (await screen.findByText('공정·설비 구성')).closest('.hierarchy') as HTMLElement;
      fireEvent.click(within(panel).getByRole('button', { name: '＋ 라인' }));
      typeName(/^라인 이름$/, 'BodyLine'); // the line row stays open
      const lineRow = (await within(panel).findByText('BodyLine')).closest('.build-row') as HTMLElement;
      fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 공정' })); // the line input row closes and the process input row opens
      fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 설비' }));
      expect(await screen.findByText('공정·설비 구성')).toBeTruthy();
      expect(screen.getByPlaceholderText(/이름만/)).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});
