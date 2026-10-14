// @vitest-environment jsdom
/**
 * Daily state view: one bar per equipment below the collection screen. Picks the state tag by name and paints running / stopped / alarm from received values.
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

/** A time inside the current shift window (starts at 08:00) */
function shiftStart(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8);
  if (now.getHours() < 8) start.setDate(start.getDate() - 1);
  return start.getTime();
}

describe('daily state', () => {
  it('picks the state tag (MachineStatus) automatically and reports running / stopped / alarm time from received values, even when the device clock is frozen', async () => {
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
    const frozen = new Date(start - 24 * 60 * MIN).toISOString(); // the device clock is stuck at yesterday
    const sample = (minutes: number, valueText: string) => ({
      packageId: 'pkg_1',
      interfaceName: 'InterfaceTemplateForOPCUA',
      propertyName: 'MachineStatus',
      observedAt: frozen,
      receivedAt: at(minutes),
      valueText,
    });
    // at 1-minute intervals: 10 min running -> 3 min stopped -> 2 min alarm (if now is before 08:15 the window end would be cut, so use yesterday's window)
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
    // the last value extends up to the hold time (5 min): 2 min alarm + hold
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/가동 10분 · 정지 3분 · 알람 \d+분/));
    const bar = within(section).getByRole('img', { name: '이 설비 하루 상태' });
    expect(bar.querySelectorAll('.state-run')).toHaveLength(1);
    expect(bar.querySelectorAll('.state-alarm')).toHaveLength(1);
  });

  it('re-reads when values arrive via Collect after the bar is drawn, without reopening the view', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(bytes) });
    // fake collection adapter: the state tag is always "running"
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
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^가동 (\d+분|1분 미만)$/)); // just received, so usually under 1 minute
  });
});
