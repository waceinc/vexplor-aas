// @vitest-environment jsdom
/**
 * 하루 상태 화면 — 수집 화면 아래 설비 한 줄 막대. 상태 태그를 이름으로 고르고, 받은 값으로 가동 · 정지 · 알람을 칠한다.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

const bytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));
const MIN = 60_000;

/** 지금 교대 창 안의 시각 — 08시 시작 */
function shiftStart(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8);
  if (now.getHours() < 8) start.setDate(start.getDate() - 1);
  return start.getTime();
}

describe('하루 상태', () => {
  it('상태 태그(MachineStatus)를 저절로 고르고, 받은 값대로 가동 · 정지 · 알람 시간을 낸다 — 장비 시각이 멈춰 있어도', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(bytes) });
    wireFetch(store);
    const made = await fetch('/packages/pkg_1/aid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'opc.tcp://10.0.0.5:4840', tags: [{ name: 'MachineStatus', href: 'ns=1;s=Status' }, { name: 'MotorSpeed', href: 'ns=1;s=Speed' }] }),
    });
    expect(made.status).toBeLessThan(300);
    const start = shiftStart();
    const at = (minutes: number): string => new Date(start + minutes * MIN).toISOString();
    const frozen = new Date(start - 24 * 60 * MIN).toISOString(); // 장비 시각은 어제에 멈춰 있다
    const sample = (minutes: number, valueText: string) => ({
      packageId: 'pkg_1',
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MachineStatus',
      observedAt: frozen,
      receivedAt: at(minutes),
      valueText,
    });
    // 1분 간격으로 10분 가동 → 3분 정지 → 2분 알람 (지금이 08:15 전이면 창 끝이 잘리므로 어제 창으로 넣는다)
    const values = [
      ...Array.from({ length: 10 }, (_, i) => sample(i, '가동')),
      ...Array.from({ length: 3 }, (_, i) => sample(10 + i, 'STOP')),
      ...Array.from({ length: 2 }, (_, i) => sample(13 + i, 'fault')),
    ];
    const lateEnough = Date.now() - start > 30 * MIN;
    await store.appendValues('pkg_1', lateEnough ? values : values.map((v) => ({ ...v, receivedAt: new Date(Date.parse(v.receivedAt) - 24 * 60 * MIN).toISOString() })));

    render(<App />);
    const section = (await screen.findByText('하루 상태')).closest('.daily-states') as HTMLElement;
    if (!lateEnough) fireEvent.click(within(section).getByRole('button', { name: '앞 날' }));
    await waitFor(() => expect((within(section).getByLabelText('이 설비 상태 태그') as HTMLSelectElement).value).toBe('MachineStatus'));
    // 마지막 값은 유지 시간(5분)까지 이어진다 — 알람 2분 + 유지분
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/가동 10분 · 정지 3분 · 알람 \d+분/));
    const bar = within(section).getByRole('img', { name: '이 설비 하루 상태' });
    expect(bar.querySelectorAll('.state-run')).toHaveLength(1);
    expect(bar.querySelectorAll('.state-alarm')).toHaveLength(1);
  });

  it('막대가 먼저 그려진 뒤 「수집」으로 값이 들어오면 다시 읽는다 — 화면을 다시 열지 않아도', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(bytes) });
    // 가짜 수집 어댑터 — 상태 태그는 언제나 「가동」
    wireFetch(store, {
      openReader: async (descriptor) => ({
        base: descriptor.base ?? '',
        read: async (sources) => sources.map((source) => ({ source, value: '가동', quality: 'Good' })),
        close: async () => {},
      }),
    });
    await fetch('/packages/pkg_1/aid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'opc.tcp://10.0.0.5:4840', tags: [{ name: 'MachineStatus', href: 'ns=1;s=Status' }] }),
    });
    render(<App />);
    const section = (await screen.findByText('하루 상태')).closest('.daily-states') as HTMLElement;
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toBe('이날 받은 값 없음'));
    fireEvent.click(screen.getByRole('button', { name: '수집' }));
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^가동 (\d+분|1분 미만)$/)); // 방금 받은 값이라 대개 1분 미만이다
  });
});
