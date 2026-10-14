// @vitest-environment jsdom
/**
 * Integrations window (design §9): what each role sees, the secret shown once, egress refusals, the 412 reload prompt,
 * dead-letter resend, exports, external-reference conflicts — against a mocked API that follows the §4 contract.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import type { AuthState, PackageDescription } from '../src/api.js';
import { settingsMenuItems } from '../src/app/headerMenus.js';
import { Integrations, visibleTabs } from '../src/components/integrations/Integrations.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();
afterEach(() => vi.restoreAllMocks());

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
type Reply = { status: number; body?: unknown };
type Route = (seen: Seen) => Reply | undefined;

/** Fetch that answers from a list of routes (first match wins) and records every request */
function mockApi(routes: Route[]): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = typeof init?.body === 'string' && headers['content-type']?.includes('json') ? (JSON.parse(init.body) as unknown) : init?.body;
    const request: Seen = { method: init?.method ?? 'GET', path: url.pathname + url.search, headers, body };
    seen.push(request);
    const reply = routes.map((route) => route(request)).find((item) => item !== undefined) ?? { status: 404, body: { messages: [{ code: 'NotFound', text: 'not found' }] } };
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const on = (method: string, path: string | RegExp, reply: Reply | ((seen: Seen) => Reply)): Route => (seen) => {
  const matches = typeof path === 'string' ? seen.path === path : path.test(seen.path);
  if (seen.method !== method || !matches) return undefined;
  return typeof reply === 'function' ? reply(seen) : reply;
};

const user = (role: 'admin' | 'editor' | 'viewer', level: 'full' | 'read-only' = 'full'): AuthState => ({
  authenticated: true,
  setupNeeded: false,
  authRequired: true,
  user: { id: 'u1', login: role, displayName: role, role, level },
});

const packages: PackageDescription[] = [
  { packageId: 'pkg_1', aasIds: ['urn:aas:1'], name: 'press.aasx', assetName: 'Press03', globalAssetId: 'urn:asset:press-03' },
  { packageId: 'pkg_2', aasIds: ['urn:aas:2'], name: 'line.aasx', assetName: 'LineA' },
];

const subscription = {
  id: 'sub_1',
  name: 'MES Changwon',
  kind: 'webhook',
  url: 'https://mes.example.com/hook',
  types: ['kr.vexplor.aas.equipment.state.changed.v1'],
  packageIds: [],
  enabled: true,
  options: {},
  secretHint: 'AbCd',
  consecutiveDead: 0,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
  stats: { pending: 1, inFlight: 0, dead: 1, succeeded: 5 },
};

const show = (auth: AuthState): void => {
  render(<Integrations auth={auth} packages={packages} onClose={() => undefined} origin="http://aas.local" />);
};
const tab = (name: string): void => {
  fireEvent.click(screen.getByRole('tab', { name }));
};

describe('Integrations — who sees what', () => {
  it('admins get every tab, editors the per-file ones, viewers and demo only feed, exports and readiness', () => {
    expect(visibleTabs(user('admin'))).toEqual(['status', 'subscriptions', 'exports', 'readiness', 'rules', 'refs', 'opcua']);
    expect(visibleTabs(user('editor'))).toEqual(['status', 'exports', 'readiness', 'rules', 'refs']);
    expect(visibleTabs(user('viewer'))).toEqual(['status', 'exports', 'readiness']);
    // An admin on a read-only key is not an admin session
    expect(visibleTabs(user('admin', 'read-only'))).toEqual(['status', 'exports', 'readiness']);
    expect(visibleTabs({ ...user('admin'), demo: { login: 'demo', password: 'demo' } })).toEqual(['status', 'exports', 'readiness']);
    // Open server (no accounts): edit, but no subscriptions
    expect(visibleTabs({ authenticated: false, setupNeeded: true, authRequired: false })).toEqual(['status', 'exports', 'readiness', 'rules', 'refs']);
  });

  it('shows the admin status with the setting that turns integration on, and the feed address', async () => {
    const seen = mockApi([
      on('GET', '/integrations/status', {
        status: 200,
        body: { enabled: false, instanceId: '9f2c4e1a7b3d', masterKey: 'missing', egress: { allow: [] }, opcua: { security: 'secure' }, backlog: { pending: 0, dead: 2 } },
      }),
    ]);
    show(user('admin'));
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    await screen.findByText('9f2c4e1a7b3d');
    expect(screen.getByText('INTEGRATIONS=on')).toBeTruthy();
    expect((screen.getByLabelText('읽어 가는 주소') as HTMLInputElement).value).toBe('http://aas.local/integrations/events?after=0');
    expect(screen.getByText(/PostgreSQL 저장소에서는 AAS_SECRET_KEY/)).toBeTruthy();
    expect(seen.some((item) => item.path === '/integrations/status')).toBe(true);
  });

  it('a viewer sees the feed address without calling the admin-only status', async () => {
    const seen = mockApi([]);
    show(user('viewer'));
    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['상태', '내보내기', '준비 점검']);
    expect((screen.getByLabelText('읽어 가는 주소') as HTMLInputElement).value).toContain('/integrations/events?after=0');
    expect(screen.queryByRole('tab', { name: '보내기 구독' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.some((item) => item.path === '/integrations/status')).toBe(false);
  });

  it('the settings menu offers integrations except to the demo account', () => {
    const base = {
      t: (text: string) => text,
      busy: false,
      lang: 'ko' as const,
      demoLocked: false,
      theme: { dark: false, toggle: () => undefined },
      bootstrap: async () => undefined,
      setShowSettings: () => undefined,
      setStartAccounts: () => undefined,
      setShowAccounts: () => undefined,
      setConfirmQuit: () => undefined,
      setShowRules: () => undefined,
    };
    const opened = vi.fn();
    const items = settingsMenuItems({ ...base, auth: user('viewer'), setShowIntegrations: opened });
    const item = items.find((entry) => entry.label === '연동 (MES · ERP · CMMS)');
    expect(item).toBeTruthy();
    item!.onClick();
    expect(opened).toHaveBeenCalledWith(true);
    const demo = settingsMenuItems({ ...base, auth: { ...user('viewer'), demo: { login: 'd', password: 'd' } }, setShowIntegrations: opened });
    expect(demo.some((entry) => entry.label === '연동 (MES · ERP · CMMS)')).toBe(false);
  });
});

describe('Integrations — subscriptions', () => {
  it('shows the signing secret once after creating, never again in the list', async () => {
    let created = false;
    const seen = mockApi([
      on('GET', '/integrations/status', { status: 200, body: { enabled: true } }),
      on('GET', '/integrations/subscriptions', () => ({ status: 200, body: { items: created ? [subscription] : [] } })),
      on('POST', '/integrations/subscriptions', () => {
        created = true;
        return { status: 201, body: { subscription, secret: 'whsec_c2VjcmV0LXNob3duLW9uY2U=' } };
      }),
    ]);
    show(user('admin'));
    tab('보내기 구독');
    fireEvent.click(await screen.findByRole('button', { name: '구독 추가' }));
    const form = screen.getByRole('form', { name: '구독 추가' });
    fireEvent.change(within(form).getByLabelText('이름'), { target: { value: 'MES Changwon' } });
    fireEvent.change(within(form).getByLabelText('주소'), { target: { value: 'https://mes.example.com/hook' } });
    fireEvent.click(within(form).getByLabelText('equipment.state.changed.v1'));
    fireEvent.click(within(form).getByLabelText('Press03'));
    fireEvent.click(within(form).getByRole('button', { name: '만들기' }));

    const box = (await screen.findByLabelText('서명 비밀값')) as HTMLInputElement;
    expect(box.value).toBe('whsec_c2VjcmV0LXNob3duLW9uY2U=');
    const post = seen.find((item) => item.method === 'POST')!;
    expect(post.body).toEqual({ name: 'MES Changwon', kind: 'webhook', url: 'https://mes.example.com/hook', types: ['kr.vexplor.aas.equipment.state.changed.v1'], packageIds: ['pkg_1'] });

    await screen.findByText('…AbCd');
    fireEvent.click(screen.getByRole('button', { name: '옮겨 적었습니다 — 닫기' }));
    expect(screen.queryByLabelText('서명 비밀값')).toBeNull();
    expect(document.body.textContent).not.toContain('whsec_c2VjcmV0LXNob3duLW9uY2U=');
  });

  it('refuses an empty type list before asking the server', async () => {
    const seen = mockApi([on('GET', '/integrations/subscriptions', { status: 200, body: { items: [] } })]);
    show(user('admin'));
    tab('보내기 구독');
    fireEvent.click(await screen.findByRole('button', { name: '구독 추가' }));
    const form = screen.getByRole('form', { name: '구독 추가' });
    fireEvent.change(within(form).getByLabelText('이름'), { target: { value: 'x' } });
    fireEvent.change(within(form).getByLabelText('주소'), { target: { value: 'https://x.example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: '만들기' }));
    expect(await screen.findByText('받을 사건을 하나 이상 고르십시오.')).toBeTruthy();
    expect(seen.some((item) => item.method === 'POST')).toBe(false);
  });

  it('shows the egress refusal (422) with the setting that allows the target', async () => {
    mockApi([
      on('GET', '/integrations/subscriptions', { status: 200, body: { items: [] } }),
      on('POST', '/integrations/subscriptions', { status: 422, body: { messages: [{ code: 'TargetNotAllowed', text: '10.20.1.5 is a private address' }] } }),
    ]);
    show(user('admin'));
    tab('보내기 구독');
    fireEvent.click(await screen.findByRole('button', { name: '구독 추가' }));
    const form = screen.getByRole('form', { name: '구독 추가' });
    fireEvent.change(within(form).getByLabelText('이름'), { target: { value: 'MES' } });
    fireEvent.change(within(form).getByLabelText('주소'), { target: { value: 'http://10.20.1.5/hook' } });
    fireEvent.change(within(form).getByLabelText('앞부분으로 고르기 (쉼표로 나눔)'), { target: { value: 'equipment.*' } });
    fireEvent.click(within(form).getByRole('button', { name: '만들기' }));
    expect(await screen.findByText('10.20.1.5 is a private address')).toBeTruthy();
    expect(screen.getByText('AAS_INTEGRATION_ALLOW')).toBeTruthy();
    // The form stays open so the address can be fixed
    expect(screen.getByRole('form', { name: '구독 추가' })).toBeTruthy();
  });

  it('shows a test delivery result and puts a dead delivery back in the queue', async () => {
    const seen = mockApi([
      on('GET', '/integrations/subscriptions', { status: 200, body: { items: [subscription] } }),
      on('POST', '/integrations/subscriptions/sub_1/test', { status: 200, body: { ok: true, statusCode: 204, durationMs: 41, address: '10.20.1.5', responseSnippet: 'ok' } }),
      on('GET', /^\/integrations\/subscriptions\/sub_1\/deliveries/, {
        status: 200,
        body: { items: [{ id: 'd1', subscriptionId: 'sub_1', eventSeq: 184223, eventId: 'evt_1', type: 'kr.vexplor.aas.equipment.state.changed.v1', status: 'dead', attempts: 12, nextAttemptAt: '2026-10-14T01:00:00.000Z', lastStatusCode: 500, lastError: 'Internal', createdAt: '', updatedAt: '' }] },
      }),
      on('POST', '/integrations/deliveries/d1/redeliver', { status: 200, body: { id: 'd1', status: 'pending', attempts: 12 } }),
    ]);
    show(user('admin'));
    tab('보내기 구독');
    fireEvent.click(await screen.findByRole('button', { name: '시험 보내기' }));
    expect(await screen.findByText('시험 성공 — 응답 204 · 41ms · 주소 10.20.1.5')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '보낸 기록' }));
    const row = (await screen.findByText('184223')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '다시 보내기' }));
    expect(await screen.findByText('184223번 사건을 다시 보낼 차례에 넣었습니다.')).toBeTruthy();
    expect(seen.some((item) => item.method === 'POST' && item.path === '/integrations/deliveries/d1/redeliver')).toBe(true);
  });
});

describe('Integrations — rules, exports, references, certificates', () => {
  const serverConfig = { schema: 'vexplor.serverIntegrationConfig/1', instanceId: '9f2c4e1a7b3d', stateRules: { run: ['가동'], stop: ['정지'], alarm: ['알람'], off: ['꺼짐'] }, timezone: 'Asia/Seoul', dayStartHour: 8, shifts: [] };

  it('asks to reload when the server rules were saved elsewhere first (412), and reloads', async () => {
    const seen = mockApi([
      on('GET', '/integrations/config', { status: 200, body: { value: serverConfig, revision: 3 } }),
      on('PUT', '/integrations/config', { status: 412, body: { messages: [{ code: 'PreconditionFailed', text: 'stale' }] } }),
    ]);
    show(user('admin'));
    tab('판정 규칙');
    const run = await screen.findByLabelText('서버 가동 규칙');
    fireEvent.change(run, { target: { value: '가동, RUN' } });
    fireEvent.blur(run);
    fireEvent.click(screen.getByRole('button', { name: '서버 규칙 저장' }));
    expect(await screen.findByText(/다른 곳에서 먼저 저장했습니다/)).toBeTruthy();
    const put = seen.find((item) => item.method === 'PUT')!;
    expect(put.headers['if-match']).toBe('"3"');
    expect((put.body as typeof serverConfig).stateRules.run).toEqual(['가동', 'RUN']);
    fireEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    await waitFor(() => expect(seen.filter((item) => item.method === 'GET' && item.path === '/integrations/config')).toHaveLength(2));
  });

  it('checks a file rule with the core parser before saving, then saves with If-Match', async () => {
    const seen = mockApi([
      on('GET', '/integrations/config', { status: 200, body: { value: serverConfig, revision: 1 } }),
      on('GET', '/packages/pkg_1/integration-config', { status: 200, body: { value: null, revision: 0 } }),
      on('GET', '/packages/pkg_1/interfaces', { status: 200, body: { source: 'aid', interfaces: [{ name: 'PLC1', protocol: 'OPCUA', properties: [{ name: 'AlarmActive', observable: true }] }] } }),
      on('PUT', '/packages/pkg_1/integration-config', (request) => ({ status: 200, body: { value: request.body, revision: 1 } })),
    ]);
    show(user('editor'));
    tab('판정 규칙');
    expect(await screen.findByText('관리자만 바꿀 수 있습니다. 모든 파일과 하루 상태 막대가 이 규칙을 사용합니다.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('파일'), { target: { value: 'pkg_1' } });
    fireEvent.click(await screen.findByRole('button', { name: '알람 규칙 더하기' }));
    // The new row has no tag yet — the parser names the field instead of the server refusing it
    fireEvent.click(screen.getByRole('button', { name: '파일 규칙 저장' }));
    expect(await screen.findByText('/alarms/0/property')).toBeTruthy();
    expect(seen.some((item) => item.method === 'PUT')).toBe(false);

    fireEvent.change(screen.getByLabelText('알람 규칙 1번째 줄 태그'), { target: { value: 'AlarmActive' } });
    fireEvent.click(screen.getByRole('button', { name: '파일 규칙 저장' }));
    expect(await screen.findByText('저장했습니다. 다음 수집 주기부터 이 규칙으로 판정합니다.')).toBeTruthy();
    const put = seen.find((item) => item.method === 'PUT')!;
    expect(put.headers['if-match']).toBe('"0"');
    expect((put.body as { alarms: { property: string; activeWhen: unknown }[] }).alarms[0]).toMatchObject({ property: 'AlarmActive', activeWhen: 'truthy' });
  });

  it('downloads exports with the chosen options; per-file exports wait for a file', async () => {
    const seen = mockApi([on('GET', /^\/integrations\/exports\/equipment/, { status: 200, body: { schema: 'vexplor.equipmentMaster/1', items: [] } })]);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    show(user('viewer'));
    tab('내보내기');
    expect((screen.getByRole('button', { name: 'BOM (구성품) 내려받기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('한국어 머리글 (사람이 볼 때 — 프로그램이 읽을 때는 끄십시오)'));
    fireEvent.click(screen.getByRole('button', { name: '설비 마스터 내려받기' }));
    expect(await screen.findByText(/내려받았습니다/)).toBeTruthy();
    expect(seen[0]!.path).toBe('/integrations/exports/equipment?format=csv&bom=1&headers=ko&lang=ko');
    fireEvent.change(screen.getByLabelText('파일'), { target: { value: 'pkg_1' } });
    expect((screen.getByRole('button', { name: 'BOM (구성품) 내려받기' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists readiness checks per file', async () => {
    mockApi([
      on('GET', '/integrations/readiness', {
        status: 200,
        body: { items: [{ packageId: 'pkg_1', checks: [{ id: 'INT-2', severity: 'error', message: 'BOM root differs from the shell asset' }] }, { packageId: 'pkg_2', checks: [] }] },
      }),
    ]);
    show(user('viewer'));
    tab('준비 점검');
    expect(await screen.findByText('BOM root differs from the shell asset')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Press03' })).toBeTruthy();
    expect(screen.getByText(/INT-2 · 막힘/)).toBeTruthy();
    // A file without findings gets no section
    expect(screen.queryByRole('heading', { name: 'LineA' })).toBeNull();
  });

  it('shows who already holds an external number (409) and does not claim it was saved', async () => {
    mockApi([
      on('GET', '/packages/pkg_1/external-refs', { status: 200, body: { value: { schema: 'vexplor.externalRefs/1', subjects: [] }, revision: 0 } }),
      on('PUT', '/packages/pkg_1/external-refs', {
        status: 409,
        body: { messages: [{ code: 'ExternalRefConflict', text: 'taken' }], claims: [{ system: 'sap-s4:PRD:100', type: 'equipment', id: '10002345', packageId: 'pkg_9', subject: 'asset|urn:asset:other' }] },
      }),
    ]);
    show(user('editor'));
    tab('외부 번호');
    fireEvent.change(screen.getByLabelText('파일'), { target: { value: 'pkg_1' } });
    fireEvent.click(await screen.findByRole('button', { name: '번호 더하기' }));
    fireEvent.change(screen.getByLabelText('1번째 줄 시스템'), { target: { value: 'sap-s4:PRD:100' } });
    fireEvent.change(screen.getByLabelText('1번째 줄 번호'), { target: { value: '10002345' } });
    fireEvent.click(screen.getByRole('button', { name: '외부 번호 저장' }));
    expect(await screen.findByText(/sap-s4:PRD:100 · equipment · 10002345 → pkg_9/)).toBeTruthy();
    expect(screen.queryByText('저장했습니다.')).toBeNull();
  });

  it('refuses to publish a cost centre before asking the server', async () => {
    const seen = mockApi([on('GET', '/packages/pkg_1/external-refs', { status: 200, body: { value: { schema: 'vexplor.externalRefs/1', subjects: [] }, revision: 0 } })]);
    show(user('editor'));
    tab('외부 번호');
    fireEvent.change(screen.getByLabelText('파일'), { target: { value: 'pkg_1' } });
    fireEvent.click(await screen.findByRole('button', { name: '번호 더하기' }));
    fireEvent.change(screen.getByLabelText('1번째 줄 시스템'), { target: { value: 'sap-s4:PRD:100' } });
    fireEvent.change(screen.getByLabelText('1번째 줄 종류'), { target: { value: 'costCenter' } });
    fireEvent.change(screen.getByLabelText('1번째 줄 번호'), { target: { value: 'CC-1' } });
    fireEvent.click(screen.getByLabelText('1번째 줄 공개'));
    fireEvent.click(screen.getByRole('button', { name: '외부 번호 저장' }));
    expect(await screen.findByText('1번째 줄: 원가센터(costCenter)는 공개할 수 없습니다.')).toBeTruthy();
    expect(seen.some((item) => item.method === 'PUT')).toBe(false);
  });

  it('dry-runs a CSV import and applies it only after a clean dry run', async () => {
    const seen = mockApi([
      on('POST', /^\/integrations\/external-refs\/import/, { status: 200, body: { changes: [{ packageId: 'pkg_1', add: [{ system: 'icube:WACE', type: 'equipment', id: 'EQ-7' }], remove: [] }], errors: [], conflicts: [] } }),
    ]);
    show(user('editor'));
    tab('외부 번호');
    const apply = screen.getByRole('button', { name: '적용' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('CSV 내용'), { target: { value: 'globalAssetId,subjectKind,subjectKey,system,type,id\nurn:asset:press-03,asset,,icube:WACE,equipment,EQ-7\n' } });
    fireEvent.click(screen.getByRole('button', { name: '미리 보기' }));
    expect(await screen.findByText('미리 보기 — 바뀔 번호 1개 · 오류 0줄 · 충돌 0건')).toBeTruthy();
    expect(seen[0]!.path).toBe('/integrations/external-refs/import?dryRun=1');
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(await screen.findByText('적용했습니다 — 바뀐 번호 1개 · 오류 0줄 · 충돌 0건')).toBeTruthy();
    expect(seen[1]!.path).toBe('/integrations/external-refs/import');
  });

  it('trusts a rejected OPC UA client certificate after confirmation', async () => {
    let trusted = false;
    const cert = { thumbprint: 'A1B2C3', subject: 'CN=UaExpert', notAfter: '2027-01-01T00:00:00.000Z' };
    const seen = mockApi([
      on('GET', '/integrations/opcua/certificates', () => ({ status: 200, body: trusted ? { trusted: [cert], rejected: [] } : { trusted: [], rejected: [cert] } })),
      on('POST', '/integrations/opcua/certificates/A1B2C3/trust', () => {
        trusted = true;
        return { status: 200, body: {} };
      }),
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    show(user('admin'));
    tab('OPC UA 인증서');
    fireEvent.click(await screen.findByRole('button', { name: '믿기' }));
    expect(await screen.findByText(/CN=UaExpert 을\(를\) 믿는 인증서로 옮겼습니다/)).toBeTruthy();
    expect(seen.some((item) => item.method === 'POST' && item.path === '/integrations/opcua/certificates/A1B2C3/trust')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: '믿기' })).toBeNull());
  });
});

describe('Deleting a file with external numbers', () => {
  it('warns that the numbers go too and the connected systems are told', async () => {
    const store = new InMemoryStore();
    await store.init();
    await store.importPackage({ name: 'm.aasx', package: readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'))) });
    wireFetch(store);
    const real = globalThis.fetch;
    // The store of this branch has no integration routes yet — answer the external-refs read as the merged server will
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/packages/pkg_1/external-refs') {
        const value = { schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'asset', globalAssetId: 'urn:a' }, refs: [{ system: 'sap-s4:PRD:100', type: 'equipment', id: '1' }, { system: 'cmms', type: 'equipment', id: '2' }] }] };
        return new Response(JSON.stringify({ value, revision: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(input, init);
    }) as typeof fetch;

    render(<App />);
    await screen.findByText('DigitalNameplate');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const header = document.querySelector('header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: /^파일/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '파일 목록' }));
    const list = document.querySelector('.file-list') as HTMLElement;
    fireEvent.click(within(list).getAllByRole('button', { name: '지우기' })[0]!);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0]![0])).toMatch(/ERP · MES 외부 번호 2개가 함께 지워지고/);
  });
});
