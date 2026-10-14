// @vitest-environment jsdom
/**
 * Daily state view: one bar per equipment below the collection screen. Picks the state tag by name and paints running / stopped / alarm from received values.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { DailyStates } from '../src/components/collection/DailyStates.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

const bytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));
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

/**
 * Server-side rules (integration design §6.1): the bar uses the rules, day start and saved tag from the server, so it
 * agrees with the state events sent to MES. A server without the routes keeps the old browser-only behaviour.
 */
describe('daily state with server rules', () => {
  interface Seen {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }

  /** Mocked API: the server config and auth vary per test; tag values are "RUNNING_X" two minutes ago */
  function serve(options: { config?: { status: number; body?: unknown }; role?: 'admin' | 'viewer'; packageConfig?: unknown }): Seen[] {
    const seen: Seen[] = [];
    const sample = (property: string) => ({
      packageId: 'p1',
      interfaceName: 'PLC1',
      propertyName: property,
      observedAt: new Date(Date.now() - 2 * MIN).toISOString(),
      receivedAt: new Date(Date.now() - 2 * MIN).toISOString(),
      valueText: 'RUNNING_X',
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      seen.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body });
      const reply = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/integrations/config' && (init?.method ?? 'GET') === 'GET') return reply(options.config?.status ?? 200, options.config?.body ?? {});
      if (url.pathname === '/integrations/config') return reply(200, { value: body, revision: 1 });
      if (url.pathname === '/auth/me') {
        return reply(200, { authenticated: true, setupNeeded: false, authRequired: true, user: { id: 'u', login: 'u', displayName: 'u', role: options.role ?? 'viewer', level: 'full' } });
      }
      if (url.pathname === '/packages/p1/interfaces') {
        return reply(200, { source: 'aid', interfaces: [{ name: 'PLC1', protocol: 'OPCUA', properties: [{ name: 'MachineStatus', observable: true }, { name: 'LineState', observable: true }] }] });
      }
      if (url.pathname === '/packages/p1/integration-config') return reply(200, { value: options.packageConfig ?? null, revision: options.packageConfig ? 2 : 0 });
      if (url.pathname === '/packages/p1/values') return reply(200, { result: [sample(url.searchParams.get('property') ?? '')] });
      return reply(404, { messages: [{ text: 'not found' }] });
    }) as typeof fetch;
    return seen;
  }

  const serverConfig = (run: string[]) => ({
    value: { schema: 'vexplor.serverIntegrationConfig/1', instanceId: '9f2c4e1a7b3d', stateRules: { run, stop: ['stop'], alarm: ['alarm'], off: ['off'] }, timezone: 'Asia/Seoul', dayStartHour: 8, shifts: [] },
    revision: 3,
  });

  const showBar = (): HTMLElement => {
    render(<DailyStates rows={[{ packageId: 'p1', name: 'Press' }]} holdMs={5 * MIN} t={(text) => text} />);
    return screen.getByText('하루 상태').closest('.daily-states') as HTMLElement;
  };

  afterEach(() => {
    localStorage.removeItem('aas.stateRules');
  });

  it('judges values with the server rules (a word the default rules do not know)', async () => {
    serve({ config: { status: 200, body: serverConfig(['RUNNING_X']) } });
    const section = showBar();
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^가동 /));
  });

  it('falls back to the browser rules when the server has no integration routes (404)', async () => {
    serve({ config: { status: 404, body: { messages: [{ text: 'not found' }] } } });
    const section = showBar();
    // Default rules do not know RUNNING_X — the old behaviour shows "Unknown"
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^판정 못함 /));
    fireEvent.click(within(section).getByRole('button', { name: '판정 규칙' }));
    const run = within(section).getByLabelText('가동 규칙') as HTMLInputElement;
    expect(run.disabled).toBe(false);
    fireEvent.blur(run, { target: { value: 'RUNNING_X' } });
    expect(JSON.parse(localStorage.getItem('aas.stateRules') ?? '{}').run).toEqual(['RUNNING_X']);
  });

  it('uses the tag saved in the package config instead of the name-based guess', async () => {
    serve({
      config: { status: 200, body: serverConfig(['RUNNING_X']) },
      packageConfig: { schema: 'vexplor.packageIntegrationConfig/1', state: { property: 'LineState', interfaceName: null, rules: null }, alarms: [], counters: [], thresholds: [], suppressProperty: null, connection: { lostAfterFailures: 2 }, isa95: { site: null, levels: {} } },
    });
    showBar();
    await waitFor(() => expect((screen.getByLabelText('Press 상태 태그') as HTMLSelectElement).value).toBe('LineState'));
  });

  it('shows server rules read-only to a non-admin', async () => {
    serve({ config: { status: 200, body: serverConfig(['RUNNING_X']) }, role: 'viewer' });
    const section = showBar();
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^가동 /));
    fireEvent.click(within(section).getByRole('button', { name: '판정 규칙' }));
    await waitFor(() => expect((within(section).getByLabelText('가동 규칙') as HTMLInputElement).disabled).toBe(true));
    expect(within(section).getByText('서버 판정 규칙은 관리자만 바꿀 수 있습니다.')).toBeTruthy();
  });

  it('offers an admin to move browser-only rules to the server once, then removes the browser copy', async () => {
    localStorage.setItem('aas.stateRules', JSON.stringify({ run: ['RUNNING_X'] }));
    const seen = serve({ config: { status: 200, body: { ...serverConfig(['가동']), revision: 0 } }, role: 'admin' });
    const section = showBar();
    fireEvent.click(await within(section).findByRole('button', { name: '브라우저 규칙을 서버로 옮기기' }));
    await waitFor(() => expect(seen.some((item) => item.method === 'PUT')).toBe(true));
    const put = seen.find((item) => item.method === 'PUT')!;
    expect(put.headers['if-match']).toBe('"0"');
    expect((put.body as { stateRules: { run: string[] } }).stateRules.run).toEqual(['RUNNING_X']);
    await waitFor(() => expect(localStorage.getItem('aas.stateRules')).toBeNull());
    expect(within(section).queryByRole('button', { name: '브라우저 규칙을 서버로 옮기기' })).toBeNull();
  });

  it('does not offer the move to a non-admin', async () => {
    localStorage.setItem('aas.stateRules', JSON.stringify({ run: ['RUNNING_X'] }));
    serve({ config: { status: 200, body: { ...serverConfig(['가동']), revision: 0 } }, role: 'viewer' });
    const section = showBar();
    await waitFor(() => expect(section.querySelector('.state-totals')?.textContent).toMatch(/^판정 못함 /));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let /auth/me settle
    expect(within(section).queryByRole('button', { name: '브라우저 규칙을 서버로 옮기기' })).toBeNull();
  });
});
