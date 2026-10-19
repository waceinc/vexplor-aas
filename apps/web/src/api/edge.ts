/**
 * API client — remote collectors (VEXPLOR Edge). Management routes of apps/api/src/edge/routes-edge-admin.ts.
 *
 * Important: a 404 on /edge/status means the server has no edge at all — EDGE=off, demo mode, or a server older than
 *    2.7.0. The screen says so instead of showing an empty list.
 * Important: the install command is built here from the code and the server address the person confirms. The edge
 *    itself is a separate program (github.com/waceinc/vexplor-edge); its get.sh downloads the release for the PC's CPU,
 *    checks SHA256SUMS and runs the installer. On Windows (Edge 1.2.0 and later) get.ps1 does the same.
 */
import { tr } from '../i18n.js';
import { ApiError, withAuth } from './http.js';

export const EDGE_REPOSITORY = 'https://github.com/waceinc/vexplor-edge';
export const EDGE_GET_SCRIPT = `${EDGE_REPOSITORY}/releases/latest/download/get.sh`;
export const EDGE_GET_SCRIPT_WINDOWS = `${EDGE_REPOSITORY}/releases/latest/download/get.ps1`;
/** The first VEXPLOR Edge release with a Windows package and get.ps1 — the Windows tab says so */
export const EDGE_WINDOWS_FROM = '1.2.0';

/** The two kinds of factory PC the connect command is made for */
export type EdgeOs = 'linux' | 'windows';

export interface EdgeStatus {
  enabled: boolean;
  switchable: boolean;
  current: {
    revision: string;
    interfaces: number;
    tags: number;
    items: { interfaceName: string; packageId: string; protocol: string; tags: number }[];
  };
}

export interface EdgeCode {
  code: string;
  expiresAt: string;
  preapproved?: { revision: string; interfaces: number; tags: number };
}

export interface EdgeInterfaceStatus {
  interfaceId: string;
  connected: boolean;
  lastError?: string | null;
  /** Edge 1.1.0 and later — absent from an older collector */
  responseMs?: number;
  readOkRatio?: number;
  reconnects?: number;
  lastDisconnectAt?: string | null;
}

/** The factory PC (edge 1.1.0 `status.host`) — each value is absent when the OS cannot give it */
export interface EdgeHostStatus {
  cpuPercent?: number;
  memoryUsedPercent?: number;
  diskFreeBytes?: number;
  diskFreePercent?: number;
  uptimeSeconds?: number;
  processUptimeSeconds?: number;
  clockOffsetMs?: number;
  queuedInMemory?: number;
  queueWriteError?: string;
  queueWriteErrorAt?: string;
}

/** The line to the server (edge 1.1.0 `status.server`) */
export interface EdgeServerLink {
  lastSendOkAt?: string | null;
  lastSendError?: string | null;
  lastSendErrorAt?: string | null;
  sendFailuresSinceOk?: number;
  roundTripMs?: number;
  oldestQueuedAt?: string | null;
}

export interface EdgeLastStatus {
  startedAt?: string;
  queuedBatches?: number;
  droppedBatches?: number;
  software?: { name: string; version: string };
  interfaces?: EdgeInterfaceStatus[];
  host?: EdgeHostStatus;
  server?: EdgeServerLink;
}

/** The server's verdict (apps/api/src/edge/health.ts) — the reasons come in the screen's language */
export interface EdgeVerdict {
  level: 'ok' | 'attention' | 'problem';
  reasons: { code: string; level: 'attention' | 'problem'; message: string; interfaceId?: string }[];
}

/** One 5-minute point of a collector's trend */
export interface EdgeHistoryPoint {
  at: string;
  values: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  clock?: number;
  rtt?: number;
  queued?: number;
  memQueued?: number;
  dropped?: number;
  fails?: number;
  links?: { id: string; up: boolean; ratio?: number; ms?: number }[];
}

export interface EdgeDeviceView {
  deviceId: string;
  name: string;
  hostname?: string;
  software: { name: string; version: string };
  registeredAt: string;
  state: 'pending-approval' | 'approved' | 'paused';
  revokedAt?: string;
  approvedRevision: string | null;
  changedSinceApproval: boolean;
  approvedVia: 'code' | 'person' | null;
  tags: number;
  lastSeenAt: string | null;
  samplesReceived: number;
  lastStatus: EdgeLastStatus | null;
  /** When the batch carrying lastStatus was made (2.8.0) */
  lastStatusAt?: string | null;
  /** Null while not judged (paused, pending, revoked, nothing received yet); absent from a server older than 2.8.0 */
  health?: EdgeVerdict | null;
}

export interface EdgePreview {
  revision: string;
  interfaces: { interfaceId: string; interfaceName: string; protocol: string; endpoint: string; tags: { tagId: string }[] }[];
}

export class EdgeApiError extends ApiError {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withAuth(init));
  if (!response.ok) {
    let text: string | undefined;
    try {
      text = ((await response.json()) as { messages?: { text?: string }[] }).messages?.[0]?.text;
    } catch {
      /* Not JSON — a proxy in front */
    }
    throw new EdgeApiError(response.status, text ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

/** Undefined when this server has no edge (404) */
export async function edgeStatus(): Promise<EdgeStatus | undefined> {
  try {
    return await call<EdgeStatus>('/edge/status');
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return undefined;
    throw caught;
  }
}

export const edgeApi = {
  enable: (enabled: boolean) => post<{ enabled: boolean }>('/edge/enable', { enabled }),
  createCode: (approveRevision?: string) => post<EdgeCode>('/edge/registration-codes', approveRevision ? { approve: { revision: approveRevision } } : undefined),
  devices: async () => (await call<{ items: EdgeDeviceView[] }>('/edge/devices')).items,
  history: async (deviceId: string) => (await call<{ items: EdgeHistoryPoint[] }>(`/edge/devices/${encodeURIComponent(deviceId)}/history`)).items,
  preview: (deviceId: string) => call<EdgePreview>(`/edge/devices/${encodeURIComponent(deviceId)}/read-list-preview`),
  approve: (deviceId: string, revision: string) => post<EdgeDeviceView>(`/edge/devices/${encodeURIComponent(deviceId)}/approve`, { revision }),
  pause: (deviceId: string) => post<EdgeDeviceView>(`/edge/devices/${encodeURIComponent(deviceId)}/pause`),
  resume: (deviceId: string) => post<EdgeDeviceView>(`/edge/devices/${encodeURIComponent(deviceId)}/resume`),
  revoke: (deviceId: string) => post<EdgeDeviceView>(`/edge/devices/${encodeURIComponent(deviceId)}/revoke`),
};

/** Characters the installer refuses — checked here so the command never fails on the factory PC */
export function unsafeForCommand(value: string): boolean {
  return /["'\\`$\s]/.test(value);
}

/** The one line the person pastes on the factory PC */
export function installCommand(server: string, code: string, proxy?: string): string {
  const options = [`--server ${server}`, `--code ${code}`, ...(proxy ? [`--proxy ${proxy}`] : [])].join(' ');
  return `curl -fsSL ${EDGE_GET_SCRIPT} | sudo sh -s -- ${options}`;
}

/**
 * The same line for a Windows PC — pasted into an elevated Command Prompt or PowerShell.
 *
 * Important: the outer `powershell -Command "…"` makes it work in both shells. Inside, TLS 1.2 is switched on first
 *    (3072 — Windows PowerShell 5.1 on Windows 10 / Server 2016 offers TLS 1.0 and GitHub refuses it), and get.ps1 runs
 *    as a script block, so no execution policy is touched; get.ps1 bypasses it for the installer file only.
 * Important: the values go inside double quotes — unsafeForCommand already refuses quotes, `$`, backticks and spaces.
 */
export function installCommandWindows(server: string, code: string, proxy?: string): string {
  const fetch = proxy ? `irm -Proxy ${proxy} -ProxyUseDefaultCredentials ${EDGE_GET_SCRIPT_WINDOWS}` : `irm ${EDGE_GET_SCRIPT_WINDOWS}`;
  const options = [`-Server ${server}`, `-Code ${code}`, ...(proxy ? [`-Proxy ${proxy}`] : [])].join(' ');
  return `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((${fetch}))) ${options}"`;
}

/** How a device is doing, from what the server knows — one word for the badge */
export type EdgeHealth = 'revoked' | 'paused' | 'pending' | 'waiting' | 'receiving' | 'silent';

/** No batch for this long while approved = silent (the edge sends at least one batch a minute while it can) */
export const SILENT_AFTER_MS = 3 * 60_000;

export function healthOf(device: EdgeDeviceView, now = Date.now()): EdgeHealth {
  if (device.revokedAt) return 'revoked';
  if (device.state === 'paused') return 'paused';
  if (device.state === 'pending-approval') return 'pending';
  if (!device.lastSeenAt) return 'waiting';
  return now - Date.parse(device.lastSeenAt) > SILENT_AFTER_MS ? 'silent' : 'receiving';
}

export function healthLabel(health: EdgeHealth): string {
  if (health === 'revoked') return tr('해지됨');
  if (health === 'paused') return tr('일시 정지 중');
  if (health === 'pending') return tr('승인 대기');
  if (health === 'waiting') return tr('첫 값 기다리는 중');
  if (health === 'silent') return tr('끊김');
  return tr('받는 중');
}

export function verdictLabel(level: EdgeVerdict['level']): string {
  if (level === 'problem') return tr('위험');
  if (level === 'attention') return tr('주의');
  return tr('정상');
}
