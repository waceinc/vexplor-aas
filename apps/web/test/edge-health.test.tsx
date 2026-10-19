// @vitest-environment jsdom
/**
 * Collector health on the "Remote collectors" screen (2.8.0): the server's OK · Attention · Problem badge with the
 * first reason on each row, the numbers behind it when the row is opened, what an edge older than 1.1.0 shows, and the
 * server's own state in Settings for admins — against a mocked API.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/api.js';
import type { EdgeDeviceView, EdgeHistoryPoint } from '../src/api/edge.js';
import { EdgePanel } from '../src/components/edge/EdgePanel.js';
import { Settings } from '../src/components/Settings.js';
import { useScreenHarness } from './harness.js';

useScreenHarness();
afterEach(() => vi.restoreAllMocks());

type Reply = { status: number; body?: unknown };
function mockApi(answer: (path: string) => Reply | undefined): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    seen.push(path);
    const reply = answer(path) ?? { status: 404, body: { messages: [{ text: 'not found' }] } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const admin: AuthState = { authenticated: true, setupNeeded: false, authRequired: true, user: { id: 'u1', login: 'a', displayName: 'A', role: 'admin', level: 'full' } };
const current = { revision: 'rev1', interfaces: 1, tags: 2, items: [] };

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const newEdge = (over: Partial<EdgeDeviceView> = {}): EdgeDeviceView => ({
  deviceId: 'dev_1',
  name: 'VEXPLOR Edge',
  hostname: 'line1-pc',
  software: { name: 'vexplor-edge', version: '1.1.0' },
  registeredAt: iso(86_400_000),
  state: 'approved',
  approvedRevision: 'rev1',
  changedSinceApproval: false,
  approvedVia: 'code',
  tags: 2,
  lastSeenAt: iso(4_000),
  samplesReceived: 1200,
  lastStatusAt: iso(4_000),
  lastStatus: {
    startedAt: iso(3_600_000),
    queuedBatches: 3,
    droppedBatches: 0,
    software: { name: 'vexplor-edge', version: '1.1.0' },
    interfaces: [{ interfaceId: 'pkg_1:InterfaceOPCUA', connected: true, lastError: null, responseMs: 18, readOkRatio: 0.82, reconnects: 2, lastDisconnectAt: iso(600_000) }],
    host: { cpuPercent: 12.5, memoryUsedPercent: 43.1, diskFreeBytes: 8 * 1024 ** 3, diskFreePercent: 7.5, uptimeSeconds: 3 * 86_400 + 4 * 3_600, processUptimeSeconds: 3_600, clockOffsetMs: 1_200, queuedInMemory: 0 },
    server: { lastSendOkAt: iso(5_000), lastSendError: '503 ServerError', lastSendErrorAt: iso(60_000), sendFailuresSinceOk: 0, roundTripMs: 64, oldestQueuedAt: iso(20_000) },
  },
  health: {
    level: 'attention',
    reasons: [
      { code: 'disk-low', level: 'attention', message: '공장 PC 디스크 남은 공간이 7.5%입니다(기준 10% 미만).' },
      { code: 'read-ok-low', level: 'attention', message: 'pkg_1:InterfaceOPCUA 읽기 성공률 82%(기준 90% 미만).', interfaceId: 'pkg_1:InterfaceOPCUA' },
    ],
  },
  ...over,
});

const history: EdgeHistoryPoint[] = [
  { at: iso(600_000), values: 60, cpu: 10, disk: 7.6, rtt: 70, links: [{ id: 'pkg_1:InterfaceOPCUA', up: true, ratio: 0.9 }] },
  { at: iso(4_000), values: 58, cpu: 12.5, disk: 7.5, rtt: 64, links: [{ id: 'pkg_1:InterfaceOPCUA', up: true, ratio: 0.82 }] },
];

function serve(devices: EdgeDeviceView[], trend: EdgeHistoryPoint[] = history) {
  return mockApi((path) => {
    if (path === '/edge/status') return { status: 200, body: { enabled: true, switchable: false, current } };
    if (path === '/edge/devices') return { status: 200, body: { items: devices } };
    if (path === '/edge/devices/dev_1/history') return { status: 200, body: { items: trend } };
    return undefined;
  });
}

describe('collector health on the row', () => {
  it('shows the verdict as a word with its colour class, and the first reason in one line', async () => {
    serve([newEdge()]);
    render(<EdgePanel auth={admin} onClose={() => undefined} />);
    const badge = await screen.findByText('주의');
    expect(badge.className).toContain('edge-verdict-attention');
    expect(screen.getByText(/디스크 남은 공간이 7\.5%/)).toBeTruthy();
    expect(screen.getByText('(이유 1개 더)')).toBeTruthy();
    // The second reason waits for the details
    expect(screen.queryByText(/읽기 성공률 82%/)).toBeNull();
  });

  it('OK and Problem badges', async () => {
    serve([newEdge({ health: { level: 'ok', reasons: [] } }), newEdge({ deviceId: 'dev_2', hostname: 'line2-pc', health: { level: 'problem', reasons: [{ code: 'no-equipment', level: 'problem', message: '설비 연결 0/1 — 연결된 설비가 없습니다.' }] } })]);
    render(<EdgePanel auth={admin} onClose={() => undefined} />);
    expect((await screen.findByText('정상')).className).toContain('edge-verdict-ok');
    expect(screen.getByText('위험').className).toContain('edge-verdict-problem');
    expect(screen.getByText('설비 연결 0/1 — 연결된 설비가 없습니다.')).toBeTruthy();
  });

  it('opening the row shows the PC, the line, each piece of equipment and the trend', async () => {
    const seen = serve([newEdge()]);
    render(<EdgePanel auth={admin} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: '상태 자세히' }));
    const details = await screen.findByTestId('edge-health');
    const facts = within(details);
    expect(facts.getByText('12.5%')).toBeTruthy();
    expect(facts.getByText('43.1%')).toBeTruthy();
    expect(facts.getByText('8 GB (7.5%)')).toBeTruthy();
    expect(facts.getByText('3일 4시간')).toBeTruthy();
    expect(facts.getByText('서버보다 1.2초 늦음')).toBeTruthy();
    expect(facts.getByText('64 ms')).toBeTruthy();
    expect(facts.getByText('3개')).toBeTruthy();
    expect(facts.getByText(/503 ServerError/)).toBeTruthy();
    expect(facts.getByText('18 ms')).toBeTruthy();
    expect(facts.getByText('82%')).toBeTruthy();
    expect(facts.getByText('2번')).toBeTruthy();
    expect(facts.getByText(/읽기 성공률 82%/)).toBeTruthy();
    await waitFor(() => expect(facts.getByRole('img', { name: /받은 값: 지금 58개/ })).toBeTruthy());
    expect(facts.getByRole('img', { name: /디스크 남은 공간: 지금 7\.5%/ })).toBeTruthy();
    expect(seen).toContain('/edge/devices/dev_1/history');
  });

  it('an edge 1.0.x says its version does not send the new numbers, instead of showing zeros', async () => {
    serve(
      [
        newEdge({
          software: { name: 'vexplor-edge', version: '1.0.1' },
          lastStatus: { startedAt: iso(60_000), queuedBatches: 0, droppedBatches: 0, software: { name: 'vexplor-edge', version: '1.0.1' }, interfaces: [{ interfaceId: 'i1', connected: true, lastError: null }] },
          health: { level: 'ok', reasons: [] },
        }),
      ],
      [{ at: iso(4_000), values: 20, links: [{ id: 'i1', up: true }] }],
    );
    render(<EdgePanel auth={admin} onClose={() => undefined} />);
    expect(await screen.findByText('정상')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '상태 자세히' }));
    const details = within(await screen.findByTestId('edge-health'));
    expect(details.getAllByText('이 버전은 보내지 않음(1.1.0 이상)').length).toBeGreaterThanOrEqual(2);
    expect(details.getByText('응답 시간 · 성공률 · 재연결 · 마지막 끊김: 이 버전은 보내지 않음(1.1.0 이상)')).toBeTruthy();
    expect(details.queryByText('0%')).toBeNull();
    await waitFor(() => expect(details.getByRole('img', { name: /받은 값: 지금 20개/ })).toBeTruthy());
  });

  it('a paused collector has no verdict badge', async () => {
    serve([newEdge({ state: 'paused', health: null })]);
    render(<EdgePanel auth={admin} onClose={() => undefined} />);
    expect(await screen.findByText('일시 정지 중')).toBeTruthy();
    expect(screen.queryByText('주의')).toBeNull();
    expect(screen.queryByText('정상')).toBeNull();
  });
});

describe('server state in Settings', () => {
  const status = {
    version: '2.8.0',
    startedAt: iso(7_200_000),
    uptimeSeconds: 7_200,
    store: { kind: 'postgres', ok: true, responseMs: 3 },
    disk: { of: 'server', path: '/app', freeBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 40 },
    edge: { batches: 720, refused: 2, samplesRejected: 1, sinceStart: false },
  };

  it('an admin sees the store, the disk, the last hour of batches and the version', async () => {
    mockApi((path) => (path === '/server/status' ? { status: 200, body: status } : undefined));
    render(<Settings lang="ko" t={(text) => text} admin onChange={() => undefined} onClose={() => undefined} />);
    expect(await screen.findByText('2.8.0')).toBeTruthy();
    expect(screen.getByText('PostgreSQL — 연결됨 (3 ms)')).toBeTruthy();
    expect(screen.getByText(/40 GB \/ 100 GB \(40%\)/)).toBeTruthy();
    expect(screen.getByText('받은 묶음 720개 · 거절한 요청 2개 · 저장하지 않은 값 1개')).toBeTruthy();
    expect(screen.getByText('원격 수집기 — 최근 1시간')).toBeTruthy();
  });

  it('a store that does not answer is said plainly', async () => {
    mockApi((path) => (path === '/server/status' ? { status: 200, body: { ...status, store: { kind: 'folder', ok: false, responseMs: 5000, error: 'EACCES' } } } : undefined));
    render(<Settings lang="ko" t={(text) => text} admin onChange={() => undefined} onClose={() => undefined} />);
    expect(await screen.findByText('폴더 — 답이 없음: EACCES')).toBeTruthy();
  });

  it('not an admin, or an older server: no section', async () => {
    const seen = mockApi(() => undefined);
    const { unmount } = render(<Settings lang="ko" t={(text) => text} onChange={() => undefined} onClose={() => undefined} />);
    expect(screen.queryByText('서버 상태')).toBeNull();
    expect(seen).not.toContain('/server/status');
    unmount();
    render(<Settings lang="ko" t={(text) => text} admin onChange={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(seen).toContain('/server/status'));
    await waitFor(() => expect(screen.queryByText('서버 상태')).toBeNull());
  });
});
