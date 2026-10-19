// @vitest-environment jsdom
/**
 * Remote collectors window (2.7.0, one-click): switching on, making the one-line command with the list approved,
 * seeing the new collector arrive, and the actions on a collector — against a mocked edge API. The Windows tab (2.9.x,
 * VEXPLOR Edge 1.2.0): the same server and code as one PowerShell line.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/api.js';
import { EDGE_WINDOWS_FROM, healthOf, installCommand, installCommandWindows, type EdgeDeviceView } from '../src/api/edge.js';
import { EdgePanel } from '../src/components/edge/EdgePanel.js';
import { fill } from '../src/i18n.js';
import { useScreenHarness } from './harness.js';

useScreenHarness();
afterEach(() => vi.restoreAllMocks());

interface Seen {
  method: string;
  path: string;
  body: unknown;
}
type Reply = { status: number; body?: unknown };

function mockApi(answer: (seen: Seen) => Reply | undefined): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const request = { method: init?.method ?? 'GET', path: url.pathname, body };
    seen.push(request);
    const reply = answer(request) ?? { status: 404, body: { messages: [{ text: 'not found' }] } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const admin: AuthState = { authenticated: true, setupNeeded: false, authRequired: true, user: { id: 'u1', login: 'a', displayName: 'A', role: 'admin', level: 'full' } };
const viewer: AuthState = { authenticated: true, setupNeeded: false, authRequired: true, user: { id: 'u2', login: 'v', displayName: 'V', role: 'viewer', level: 'read-only' } };

const current = { revision: 'rev1', interfaces: 1, tags: 2, items: [{ interfaceName: 'OPCUA', packageId: 'pkg_1', protocol: 'OPCUA', tags: 2 }] };
const device = (over: Partial<EdgeDeviceView> = {}): EdgeDeviceView => ({
  deviceId: 'dev_1',
  name: 'VEXPLOR Edge',
  hostname: 'line1-pc',
  software: { name: 'vexplor-edge', version: '1.0.0' },
  registeredAt: '2026-10-18T00:00:00.000Z',
  state: 'approved',
  approvedRevision: 'rev1',
  changedSinceApproval: false,
  approvedVia: 'code',
  tags: 2,
  lastSeenAt: new Date().toISOString(),
  samplesReceived: 12,
  lastStatus: { queuedBatches: 0, interfaces: [{ interfaceId: 'i1', connected: true, lastError: null }] },
  ...over,
});

describe('EdgePanel', () => {
  it('a server without edge says why', async () => {
    mockApi(() => undefined);
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    expect(await screen.findByText(/EDGE=off/)).toBeTruthy();
  });

  it('off and switchable: an admin switches it on with one button; a viewer is told an admin can', async () => {
    let enabled = false;
    const seen = mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled, switchable: true, current } };
      if (request.path === '/edge/enable') {
        enabled = true;
        return { status: 200, body: { enabled: true } };
      }
      if (request.path === '/edge/devices') return { status: 200, body: { items: [] } };
      return undefined;
    });
    const { unmount } = render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: '원격 수집 켜기' }));
    expect(await screen.findByRole('button', { name: '+ 수집기 연결' })).toBeTruthy();
    expect(seen.some((request) => request.path === '/edge/enable' && (request.body as { enabled: boolean }).enabled)).toBe(true);
    unmount();

    enabled = false;
    render(<EdgePanel auth={viewer} onClose={() => undefined} origin="https://aas.example.com" />);
    expect(await screen.findByText('관리자 계정으로 로그인하면 여기서 켤 수 있습니다.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '원격 수집 켜기' })).toBeNull();
  });

  it('one click: the command carries the server and code, the list is approved, and the new collector shows up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let arrived = false;
    const seen = mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
      if (request.path === '/edge/devices') return { status: 200, body: { items: arrived ? [device()] : [] } };
      if (request.path === '/edge/registration-codes') return { status: 201, body: { code: 'ABCD-EFGH-JKMN', expiresAt: '2026-10-19T00:00:00.000Z', preapproved: { revision: 'rev1', interfaces: 1, tags: 2 } } };
      return undefined;
    });
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 수집기 연결' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '연결 명령 만들기' }));

    const command = await screen.findByLabelText('설치 명령');
    expect(command.textContent).toBe(installCommand('https://aas.example.com', 'ABCD-EFGH-JKMN'));
    expect(command.textContent).toContain('--server https://aas.example.com --code ABCD-EFGH-JKMN');
    expect(seen.find((request) => request.path === '/edge/registration-codes')?.body).toEqual({ approve: { revision: 'rev1' } });
    expect(screen.getByText(/공장 PC를 기다리는 중입니다/)).toBeTruthy();

    arrived = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await waitFor(() => expect(screen.getByText('연결되었습니다 — line1-pc')).toBeTruthy());
    vi.useRealTimers();
  });

  it('Windows tab: the same server and code as one PowerShell line, a copy button, and the version it needs', async () => {
    mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
      if (request.path === '/edge/devices') return { status: 200, body: { items: [] } };
      if (request.path === '/edge/registration-codes') return { status: 201, body: { code: 'ABCD-EFGH-JKMN', expiresAt: '2026-10-19T00:00:00.000Z' } };
      return undefined;
    });
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 수집기 연결' }));
    fireEvent.click(screen.getByRole('button', { name: '프록시를 거쳐야 하나요?' }));
    fireEvent.change(screen.getByPlaceholderText('http://proxy.plant.local:3128'), { target: { value: 'http://proxy.plant.local:3128' } });
    fireEvent.click(screen.getByRole('button', { name: '연결 명령 만들기' }));

    // Linux is the first tab, as before
    const linuxTab = await screen.findByRole('tab', { name: 'Linux' });
    expect(linuxTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('설치 명령').textContent).toBe(installCommand('https://aas.example.com', 'ABCD-EFGH-JKMN', 'http://proxy.plant.local:3128'));

    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(screen.getByRole('tab', { name: 'Windows' }).getAttribute('aria-selected')).toBe('true');
    const command = screen.getByLabelText('설치 명령').textContent ?? '';
    expect(command).toBe(installCommandWindows('https://aas.example.com', 'ABCD-EFGH-JKMN', 'http://proxy.plant.local:3128'));
    expect(command).toMatch(/^powershell -NoProfile -Command "/);
    expect(command).toContain('releases/latest/download/get.ps1');
    expect(command).toContain('-Server https://aas.example.com -Code ABCD-EFGH-JKMN -Proxy http://proxy.plant.local:3128"');
    // The first download goes through the proxy too, and TLS 1.2 is on before it
    expect(command).toContain('irm -Proxy http://proxy.plant.local:3128 -ProxyUseDefaultCredentials https://');
    expect(command.indexOf('-bor 3072')).toBeLessThan(command.indexOf('irm '));
    expect(command).not.toMatch(/ExecutionPolicy/);
    expect(screen.getByText(fill('VEXPLOR Edge {0} 부터 — 그 판이 나오기 전에는 이 명령이 동작하지 않습니다.', { 0: EDGE_WINDOWS_FROM }))).toBeTruthy();
    expect(screen.getByText(/관리자 권한으로 실행/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(copied).toEqual([command]));
  });

  it('an address with a quote or no scheme cannot make a command', async () => {
    mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
      if (request.path === '/edge/devices') return { status: 200, body: { items: [] } };
      return undefined;
    });
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 수집기 연결' }));
    const field = screen.getByDisplayValue('https://aas.example.com');
    fireEvent.change(field, { target: { value: 'aas.example.com' } });
    expect((screen.getByRole('button', { name: '연결 명령 만들기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'https://aas.example.com";rm' } });
    expect((screen.getByRole('button', { name: '연결 명령 만들기' }) as HTMLButtonElement).disabled).toBe(true);
    // The collector refuses plain http to another host — the screen does not make a command that would fail there
    fireEvent.change(field, { target: { value: 'http://aas.example.com' } });
    expect((screen.getByRole('button', { name: '연결 명령 만들기' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/https 주소로만/)).toBeTruthy();
    fireEvent.change(field, { target: { value: 'http://localhost:8080' } });
    expect((screen.getByRole('button', { name: '연결 명령 만들기' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a pending collector is approved after its list is shown; a paused one resumes', async () => {
    let state: EdgeDeviceView['state'] = 'pending-approval';
    const seen = mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
      if (request.path === '/edge/devices') return { status: 200, body: { items: [device({ state, approvedRevision: state === 'pending-approval' ? null : 'rev1', lastSeenAt: null })] } };
      if (request.path === '/edge/devices/dev_1/read-list-preview') {
        return { status: 200, body: { revision: 'rev1', interfaces: [{ interfaceId: 'i1', interfaceName: 'OPCUA', protocol: 'OPCUA', endpoint: 'opc.tcp://10.0.0.5:4840', tags: [{ tagId: 't1' }, { tagId: 't2' }] }] } };
      }
      if (request.path === '/edge/devices/dev_1/approve') {
        state = 'paused';
        return { status: 200, body: device() };
      }
      if (request.path === '/edge/devices/dev_1/resume') {
        state = 'approved';
        return { status: 200, body: device() };
      }
      return undefined;
    });
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: '목록 보고 승인' }));
    expect(await screen.findByText('opc.tcp://10.0.0.5:4840')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '이 목록으로 승인' }));
    await waitFor(() => expect(seen.find((request) => request.path === '/edge/devices/dev_1/approve')?.body).toEqual({ revision: 'rev1' }));
    fireEvent.click(await screen.findByRole('button', { name: '다시 시작' }));
    await waitFor(() => expect(seen.some((request) => request.path === '/edge/devices/dev_1/resume')).toBe(true));
  });

  it('shows the version the collector runs now, not the one it registered with', async () => {
    mockApi((request) => {
      if (request.path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
      if (request.path === '/edge/devices') return { status: 200, body: { items: [device({ software: { name: 'vexplor-edge', version: '1.0.0' }, lastStatus: { software: { name: 'vexplor-edge', version: '1.1.0' } } })] } };
      return undefined;
    });
    render(<EdgePanel auth={admin} onClose={() => undefined} origin="https://aas.example.com" />);
    expect(await screen.findByText('vexplor-edge 1.1.0')).toBeTruthy();
  });

  it('health: receiving, silent after three minutes, waiting before the first batch', () => {
    const now = Date.parse('2026-10-18T01:00:00.000Z');
    expect(healthOf(device({ lastSeenAt: '2026-10-18T00:59:30.000Z' }), now)).toBe('receiving');
    expect(healthOf(device({ lastSeenAt: '2026-10-18T00:50:00.000Z' }), now)).toBe('silent');
    expect(healthOf(device({ lastSeenAt: null }), now)).toBe('waiting');
    expect(healthOf(device({ revokedAt: '2026-10-18T00:00:00.000Z' }), now)).toBe('revoked');
  });
});
