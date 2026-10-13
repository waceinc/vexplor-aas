// @vitest-environment jsdom
/**
 * 라인 층 화면 — 회사 줄의 「＋ 라인」, 라인 줄의 「＋ 공정」, 그 밑 「＋ 설비」. 즉시 모드(만든 뒤)와 초안(새로 만들기) 둘 다.
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

/** 입력 줄에 이름을 적고 Enter */
function typeName(label: RegExp, name: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('라인 층 화면', () => {
  it('만든 회사 파일에서 「＋ 라인」 → 라인 줄의 「＋ 공정」 — 파일에 라인 → 공정으로 남고 요약에 라인 수가 나온다', async () => {
    const store = new InMemoryStore();
    await store.init();
    wireFetch(store);
    await fetch('/packages/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetName: 'WaceFactory', unit: 'composite' }) });
    render(<App />);

    const panel = (await screen.findByText('공정·설비 구성')).closest('.hierarchy') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: '＋ 라인' }));
    typeName(/^라인 이름$/, 'BodyLine');
    await waitFor(async () => expect((await tree('pkg_1'))[0]).toMatchObject({ name: 'BodyLine', line: true }));

    // 라인 줄에는 「＋ 공정」이 붙고, 공정 줄에는 붙지 않는다
    const lineRow = (await within(panel).findByText('BodyLine')).closest('.build-row') as HTMLElement;
    fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 공정' }));
    typeName(/^공정 이름$/, 'WeldingProcess');
    await waitFor(async () => expect((await tree('pkg_1'))[0]!.children[0]).toMatchObject({ name: 'WeldingProcess', line: false }));
    const processRow = (await within(panel).findByText('WeldingProcess')).closest('.build-row') as HTMLElement;
    expect(within(processRow).queryByRole('button', { name: '＋ 공정' })).toBeNull();
    expect(within(processRow).getByRole('button', { name: '＋ 설비' })).toBeTruthy();

    // 요약 타일에 라인 1 — 공정·그룹과 따로 센다
    const tiles = document.querySelector('.summary .tiles') as HTMLElement;
    await waitFor(() => expect(within(tiles).getByText('라인').previousElementSibling?.textContent).toBe('1'));
    expect(within(tiles).getByText('공정·그룹').previousElementSibling?.textContent).toBe('1');
  });

  it('새로 만들기(초안)에서도 라인 → 공정 → 이름만 설비가 그대로 만들어진다', async () => {
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

  it('입력 줄을 바꿔 열어도 화면이 멈추지 않는다 — scrollIntoView 가 Promise 를 돌려주는 브라우저에서도', async () => {
    // 요즘 크롬처럼 Promise 를 돌려준다. 효과가 그것을 돌려주면 React 가 정리 함수로 불러 화면 전체가 멈췄다(2026-10-14)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => Promise.resolve(), configurable: true });
    try {
      const store = new InMemoryStore();
      await store.init();
      wireFetch(store);
      await fetch('/packages/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetName: 'WaceFactory', unit: 'composite' }) });
      render(<App />);
      const panel = (await screen.findByText('공정·설비 구성')).closest('.hierarchy') as HTMLElement;
      fireEvent.click(within(panel).getByRole('button', { name: '＋ 라인' }));
      typeName(/^라인 이름$/, 'BodyLine'); // 라인 줄은 열린 채로 남는다
      const lineRow = (await within(panel).findByText('BodyLine')).closest('.build-row') as HTMLElement;
      fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 공정' })); // 라인 입력 줄이 닫히고 공정 입력 줄이 열린다
      fireEvent.click(within(lineRow).getByRole('button', { name: '＋ 설비' }));
      expect(await screen.findByText('공정·설비 구성')).toBeTruthy();
      expect(screen.getByPlaceholderText(/이름만/)).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});
