/**
 * Narrowing an `AasStore` to the integration port, and the server instance id.
 *
 * Composition point (WP1): once `AasStore extends IntegrationStore`, `supportsIntegration` is always true and
 * `integrationStore` is the identity. Until then a store without the port is reported clearly instead of failing
 * with "readEvents is not a function" deep inside a route.
 */
import { randomBytes } from 'node:crypto';

import { tr } from '@aas/core';
import type { AasStore, IntegrationStore } from '@aas/store';

import type { IntegrationAasStore } from './deps.js';

export function supportsIntegration(store: AasStore): store is IntegrationAasStore {
  const port = store as Partial<IntegrationStore>;
  return typeof port.readEvents === 'function' && typeof port.claimDeliveries === 'function';
}

export function integrationStore(store: AasStore): IntegrationAasStore {
  if (!supportsIntegration(store)) throw new Error(tr('이 저장소는 연동 기능을 지원하지 않습니다.'));
  return store;
}

/** Runtime state key of the instance id. Not in the server config: writing it there would make "never saved" (revision 0) untrue */
export const INSTANCE_ID_KEY = 'integration:instanceId';

const isInstanceId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value);

/**
 * The 12-hex instance id of this server (`source: urn:vexplor-aas:<id>`), created on first need and kept, so event
 * sources stay the same across restarts. A value already in the server config (`instanceId`) wins.
 * Must run outside a workspace context (runtime state is server-only).
 */
export async function ensureInstanceId(store: IntegrationAasStore): Promise<string> {
  const config = (await store.getServerIntegrationConfig())?.value as { instanceId?: unknown } | undefined;
  if (isInstanceId(config?.instanceId)) return config.instanceId;
  const kept = await store.getRuntimeState(INSTANCE_ID_KEY);
  if (isInstanceId(kept)) return kept;
  const created = randomBytes(6).toString('hex');
  await store.putRuntimeState(INSTANCE_ID_KEY, created);
  return created;
}

export function randomInstanceId(): string {
  return randomBytes(6).toString('hex');
}
