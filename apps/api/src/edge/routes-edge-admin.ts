/**
 * Edge management for people (normal login or API key): make a registration code, list devices, preview and approve
 * what a device may read, pause it, revoke it.
 *
 *     GET  /edge/status                                → on or off, whether the screen may switch it, the list now
 *     POST /edge/enable  { enabled }                   → admin session only, when EDGE is not set
 *     POST /edge/registration-codes  { approve? }      → { code, expiresAt, preapproved? } — shown once
 *     GET  /edge/devices                               → devices of this workspace, with "list changed since approval"
 *                                                        and their last batch (time, values, connection status)
 *                                                        and how it is doing: health OK · Attention · Problem with reasons
 *     GET  /edge/devices/:deviceId/history             → its trend: the last 24 hours, one point per 5 minutes
 *     GET  /edge/devices/:deviceId/read-list-preview   → what approving now would grant, with its revision
 *     POST /edge/devices/:deviceId/approve  { revision } → the device starts reading exactly that list
 *     POST /edge/devices/:deviceId/pause | /resume | /revoke
 *
 * Important: approval names the revision the person looked at. If the files changed between the preview and the click,
 *    the revisions differ and the approval is refused (409) — nobody approves a list they have not seen.
 * Important: one-click — `approve: { revision }` on the code is the same approval, made before the device exists. The
 *    revision must be the one the person was shown (GET /edge/status), or the code is refused (409).
 * Important: a device's list is always computed in the device's workspace, not the approver's. An admin who sees
 *    everything must not hand a device the files of other workspaces by approving it.
 */
import { fill, tr } from '@aas/core';
import { currentWorkspace, runInWorkspace, type AasStore } from '@aas/store';
import { ApiError, json } from '../http.js';
import { requireAdminSession } from '../integration/route-support.js';
import type { Route } from '../router.js';
import { currentInterfaces, revisionOf, type ReadListInterface } from './read-list.js';
import { deviceWorkspace, servedList } from './routes-edge.js';
import { judgeEdge } from './health.js';
import type { EdgeDevice, EdgeRegistry } from './state.js';

export interface EdgeAdminOptions {
  registry: EdgeRegistry;
  store: AasStore;
  intervalMs: number;
  /** The server splits workspaces (AAS_WORKSPACE=private or demo) */
  partitioned?: boolean;
  /** 'on' — EDGE=on decides; 'switchable' — EDGE is not set and an admin switches it on the screen. Default 'on' */
  mode?: 'on' | 'switchable';
  now?: () => Date;
}

const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 3_600_000;

/**
 * The approved list with the person's read intervals (plan gap 6): `{ <interfaceId | tagId>: ms }`, 100 ms – 1 h.
 * An interface id sets the interface; a tag id overrides one tag. An id not in the list is an error, not ignored —
 * a typo would otherwise leave a tag read at the default without anyone noticing.
 */
function withIntervals(interfaces: ReadListInterface[], intervals: unknown): ReadListInterface[] {
  if (intervals === undefined) return interfaces;
  if (typeof intervals !== 'object' || intervals === null || Array.isArray(intervals)) {
    throw new ApiError(400, 'BadRequest', tr('intervals 는 { id: 밀리초 } 형태여야 합니다.'));
  }
  const wanted = new Map(Object.entries(intervals as Record<string, unknown>));
  for (const [id, ms] of wanted) {
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
      throw new ApiError(400, 'BadRequest', fill(tr('{0} 의 주기는 100ms 에서 1시간 사이 정수(밀리초)여야 합니다.'), { 0: id }));
    }
  }
  const known = new Set(interfaces.flatMap((iface) => [iface.interfaceId, ...iface.tags.map((tag) => tag.tagId)]));
  const unknown = [...wanted.keys()].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new ApiError(400, 'BadRequest', fill(tr('목록에 없는 id 입니다: {0}'), { 0: unknown.join(', ') }));
  return interfaces.map((iface) => ({
    ...iface,
    intervalMs: (wanted.get(iface.interfaceId) as number | undefined) ?? iface.intervalMs,
    tags: iface.tags.map((tag) => (wanted.has(tag.tagId) ? { ...tag, intervalMs: wanted.get(tag.tagId) as number } : tag)),
  }));
}

/** Whether the caller may see and manage this device */
function visible(device: EdgeDevice): boolean {
  const workspace = currentWorkspace();
  return workspace === undefined || workspace.seesAll || device.workspace === workspace.key;
}

export function edgeAdminRoutes(options: EdgeAdminOptions): Route[] {
  const now = options.now ?? (() => new Date());

  const deviceOf = async (deviceId: string): Promise<EdgeDevice> => {
    const device = await options.registry.device(deviceId);
    if (!device || !visible(device)) throw new ApiError(404, 'NotFound', fill(tr('장치 {0}을(를) 찾을 수 없습니다.'), { 0: deviceId }));
    return device;
  };
  const mode = options.mode ?? 'on';
  const isOn = async (): Promise<boolean> => mode === 'on' || (await options.registry.enabled());
  const requireOn = async (): Promise<void> => {
    if (!(await isOn())) throw new ApiError(409, 'Conflict', tr('원격 수집이 꺼져 있습니다 — 관리자가 「원격 수집기」 화면에서 켜십시오.'));
  };
  /** The list a device of the caller's workspace would read now */
  const currentList = async () => {
    const workspace = currentWorkspace();
    const interfaces = await currentInterfaces(options.store, options.intervalMs, workspace?.key ?? null);
    return { revision: revisionOf(interfaces), interfaces };
  };
  const preview = (device: EdgeDevice) =>
    runInWorkspace(deviceWorkspace(device), async () => {
      const interfaces = await currentInterfaces(options.store, options.intervalMs, device.workspace);
      return { revision: revisionOf(interfaces), interfaces };
    });
  type Preview = Awaited<ReturnType<typeof preview>>;
  /**
   * `previews` is shared by the devices of one request: the list depends only on the device's workspace, so it is made
   * once per workspace, not once per device (2.8.1 — 200 devices took 114 s, each re-reading every file).
   */
  const summary = async (device: EdgeDevice, previews = new Map<string | null, Promise<Preview>>()) => {
    const { publicKey: _key, approved, ...rest } = device;
    let pending = previews.get(device.workspace);
    if (!pending) previews.set(device.workspace, (pending = preview(device)));
    const current = await pending;
    const activity = await options.registry.activity(device.deviceId);
    return {
      ...rest,
      served: servedList(device).revision,
      approvedRevision: approved?.revision ?? null,
      currentRevision: current.revision,
      changedSinceApproval: approved !== undefined && (approved.basis ?? approved.revision) !== current.revision,
      tags: current.interfaces.reduce((sum, iface) => sum + iface.tags.length, 0),
      approvedVia: rest.approvedVia ?? (approved ? 'person' : null),
      lastSeenAt: activity?.lastSeenAt ?? null,
      samplesReceived: activity?.samplesReceived ?? 0,
      lastStatus: activity?.lastStatus ?? null,
      lastStatusAt: activity?.lastStatusAt ?? null,
      // Judged only while the device is meant to send — a paused, pending or revoked one is shown by its state
      health:
        device.state === 'approved' && !device.revokedAt
          ? judgeEdge({ lastSeenAt: activity?.lastSeenAt ?? null, lastStatus: activity?.lastStatus ?? null, history: await options.registry.history(device.deviceId), ...(activity?.lastStatusAt ? { statusAt: activity.lastStatusAt } : {}) }, now())
          : null,
    };
  };
  const change = async (deviceId: string, edit: (device: EdgeDevice) => EdgeDevice) => {
    await deviceOf(deviceId);
    const updated = await options.registry.update(deviceId, edit);
    return json(200, await summary(updated!));
  };

  return [
    {
      method: 'GET',
      pattern: '/edge/status',
      async handle() {
        const current = await currentList();
        return json(200, {
          enabled: await isOn(),
          switchable: mode === 'switchable',
          current: {
            revision: current.revision,
            interfaces: current.interfaces.length,
            tags: current.interfaces.reduce((sum, iface) => sum + iface.tags.length, 0),
            items: current.interfaces.map((iface) => ({ interfaceName: iface.interfaceName, packageId: iface.packageId, protocol: iface.protocol, tags: iface.tags.length })),
          },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/edge/enable',
      async handle({ request }) {
        requireAdminSession(request);
        if (mode !== 'switchable') throw new ApiError(409, 'Conflict', tr('서버 설정 EDGE 가 정해 두었습니다 — 화면에서 바꿀 수 없습니다.'));
        const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
        if (typeof enabled !== 'boolean') throw new ApiError(400, 'BadRequest', tr('enabled 는 true 또는 false 여야 합니다.'));
        await options.registry.setEnabled(enabled);
        return json(200, { enabled, switchable: true });
      },
    },
    {
      method: 'POST',
      pattern: '/edge/registration-codes',
      async handle({ request }) {
        await requireOn();
        const approve = (request.body as { approve?: { revision?: unknown } } | undefined)?.approve;
        if (approve === undefined) return json(201, await options.registry.createCode(currentWorkspace()?.key ?? null));
        if (typeof approve?.revision !== 'string') throw new ApiError(400, 'BadRequest', tr('approve.revision 이 필요합니다(원격 수집 상태에서 받은 값).'));
        if (options.partitioned && currentWorkspace() === undefined) {
          throw new ApiError(409, 'Conflict', tr('작업 공간을 알 수 없어 미리 승인할 수 없습니다.'));
        }
        const current = await currentList();
        if (current.revision !== approve.revision) throw new ApiError(409, 'Conflict', tr('미리 본 뒤 목록이 바뀌었습니다 — 다시 보고 승인하십시오.'));
        if (current.interfaces.length === 0) throw new ApiError(409, 'Conflict', tr('읽을 태그가 없습니다 — AID(설비 연결 정보)가 있는 AASX 를 먼저 올리십시오.'));
        const created = await options.registry.createCode(currentWorkspace()?.key ?? null, 24, {
          revision: current.revision,
          basis: current.revision,
          approvedAt: now().toISOString(),
          interfaces: current.interfaces,
        });
        const tags = current.interfaces.reduce((sum, iface) => sum + iface.tags.length, 0);
        return json(201, { ...created, preapproved: { revision: current.revision, interfaces: current.interfaces.length, tags } });
      },
    },
    {
      method: 'GET',
      pattern: '/edge/devices',
      async handle() {
        const devices = (await options.registry.list()).filter(visible);
        const previews = new Map<string | null, Promise<Preview>>();
        return json(200, { items: await Promise.all(devices.map((device) => summary(device, previews))) });
      },
    },
    {
      method: 'GET',
      pattern: '/edge/devices/:deviceId/history',
      async handle({ params }) {
        const device = await deviceOf(params['deviceId']!);
        return json(200, { items: await options.registry.history(device.deviceId) });
      },
    },
    {
      method: 'GET',
      pattern: '/edge/devices/:deviceId/read-list-preview',
      async handle({ params }) {
        return json(200, await preview(await deviceOf(params['deviceId']!)));
      },
    },
    {
      method: 'POST',
      pattern: '/edge/devices/:deviceId/approve',
      async handle({ request, params }) {
        const device = await deviceOf(params['deviceId']!);
        if (device.revokedAt) throw new ApiError(409, 'Conflict', tr('해지된 장치는 승인할 수 없습니다.'));
        // Registered before this server split workspaces: it has none, and approving it would hand it every file (review M4)
        if (options.partitioned && device.workspace === null) {
          throw new ApiError(409, 'Conflict', tr('작업 공간을 나누기 전에 등록된 장치입니다 — 해지하고 새 코드로 다시 등록하십시오.'));
        }
        const revision = (request.body as { revision?: unknown } | undefined)?.revision;
        if (typeof revision !== 'string') throw new ApiError(400, 'BadRequest', tr('승인할 목록의 revision 이 필요합니다(미리 보기에서 받은 값).'));
        const current = await preview(device);
        if (current.revision !== revision) {
          throw new ApiError(409, 'Conflict', tr('미리 본 뒤 목록이 바뀌었습니다 — 다시 미리 보고 승인하십시오.'));
        }
        const interfaces = withIntervals(current.interfaces, (request.body as { intervals?: unknown }).intervals);
        const approvedAt = now().toISOString();
        return change(device.deviceId, (d) => ({
          ...d,
          state: 'approved',
          approved: { revision: revisionOf(interfaces), basis: revision, approvedAt, interfaces },
          approvedVia: 'person',
        }));
      },
    },
    {
      method: 'POST',
      pattern: '/edge/devices/:deviceId/pause',
      async handle({ params }) {
        return change(params['deviceId']!, (d) => ({ ...d, state: 'paused' }));
      },
    },
    {
      method: 'POST',
      pattern: '/edge/devices/:deviceId/resume',
      async handle({ params }) {
        const device = await deviceOf(params['deviceId']!);
        if (device.revokedAt) throw new ApiError(409, 'Conflict', tr('해지된 장치는 다시 시작할 수 없습니다 — 새 코드로 다시 연결하십시오.'));
        if (!device.approved) throw new ApiError(409, 'Conflict', tr('승인한 목록이 없습니다 — 먼저 읽을 목록을 승인하십시오.'));
        return change(device.deviceId, (d) => ({ ...d, state: 'approved' }));
      },
    },
    {
      method: 'POST',
      pattern: '/edge/devices/:deviceId/revoke',
      async handle({ params }) {
        const revokedAt = now().toISOString();
        return change(params['deviceId']!, (d) => ({ ...d, state: 'paused', revokedAt: d.revokedAt ?? revokedAt }));
      },
    },
  ];
}
