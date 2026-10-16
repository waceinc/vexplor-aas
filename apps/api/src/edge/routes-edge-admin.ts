/**
 * Edge management for people (normal login or API key): make a registration code, list devices, preview and approve
 * what a device may read, pause it, revoke it.
 *
 *     POST /edge/registration-codes                    → { code, expiresAt } — shown once
 *     GET  /edge/devices                               → devices of this workspace, with "list changed since approval"
 *     GET  /edge/devices/:deviceId/read-list-preview   → what approving now would grant, with its revision
 *     POST /edge/devices/:deviceId/approve  { revision } → the device starts reading exactly that list
 *     POST /edge/devices/:deviceId/pause | /revoke
 *
 * Important: approval names the revision the person looked at. If the files changed between the preview and the click,
 *    the revisions differ and the approval is refused (409) — nobody approves a list they have not seen.
 * Important: a device's list is always computed in the device's workspace, not the approver's. An admin who sees
 *    everything must not hand a device the files of other workspaces by approving it.
 */
import { fill, tr } from '@aas/core';
import { currentWorkspace, runInWorkspace, type AasStore } from '@aas/store';
import { ApiError, json } from '../http.js';
import type { Route } from '../router.js';
import { currentInterfaces, revisionOf } from './read-list.js';
import { deviceWorkspace, servedList } from './routes-edge.js';
import type { EdgeDevice, EdgeRegistry } from './state.js';

export interface EdgeAdminOptions {
  registry: EdgeRegistry;
  store: AasStore;
  intervalMs: number;
  now?: () => Date;
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
  const preview = (device: EdgeDevice) =>
    runInWorkspace(deviceWorkspace(device), async () => {
      const interfaces = await currentInterfaces(options.store, options.intervalMs);
      return { revision: revisionOf(interfaces), interfaces };
    });
  const summary = async (device: EdgeDevice) => {
    const { publicKey: _key, approved, ...rest } = device;
    const current = await preview(device);
    return {
      ...rest,
      served: servedList(device).revision,
      approvedRevision: approved?.revision ?? null,
      currentRevision: current.revision,
      changedSinceApproval: approved !== undefined && approved.revision !== current.revision,
      tags: current.interfaces.reduce((sum, iface) => sum + iface.tags.length, 0),
    };
  };
  const change = async (deviceId: string, edit: (device: EdgeDevice) => EdgeDevice) => {
    await deviceOf(deviceId);
    const updated = await options.registry.update(deviceId, edit);
    return json(200, await summary(updated!));
  };

  return [
    {
      method: 'POST',
      pattern: '/edge/registration-codes',
      async handle() {
        const created = await options.registry.createCode(currentWorkspace()?.key ?? null);
        return json(201, created);
      },
    },
    {
      method: 'GET',
      pattern: '/edge/devices',
      async handle() {
        const devices = (await options.registry.list()).filter(visible);
        return json(200, { items: await Promise.all(devices.map(summary)) });
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
        const revision = (request.body as { revision?: unknown } | undefined)?.revision;
        if (typeof revision !== 'string') throw new ApiError(400, 'BadRequest', tr('승인할 목록의 revision 이 필요합니다(미리 보기에서 받은 값).'));
        const current = await preview(device);
        if (current.revision !== revision) {
          throw new ApiError(409, 'Conflict', tr('미리 본 뒤 목록이 바뀌었습니다 — 다시 미리 보고 승인하십시오.'));
        }
        const approvedAt = now().toISOString();
        return change(device.deviceId, (d) => ({ ...d, state: 'approved', approved: { revision, approvedAt, interfaces: current.interfaces } }));
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
      pattern: '/edge/devices/:deviceId/revoke',
      async handle({ params }) {
        const revokedAt = now().toISOString();
        return change(params['deviceId']!, (d) => ({ ...d, state: 'paused', revokedAt: d.revokedAt ?? revokedAt }));
      },
    },
  ];
}
