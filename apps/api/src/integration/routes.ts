/**
 * All integration routes (docs/design/integration-v1.md §4) — mounted by `buildRoutes` in api.ts.
 *
 * WP3's own routes are always here; the WP2 / WP4 builders come in through `integrationRouteBuilders()` (compose.ts),
 * which is empty until those packages are merged. Every pattern any of them mounts is listed in
 * `scripts/part2-coverage.mjs` EXTENSIONS.
 */
import type { AasStore } from '@aas/store';

import type { Route } from '../router.js';
import { integrationRouteBuilders, type IntegrationRouteBuilders } from './compose.js';
import type { IntegrationRouteDeps } from './deps.js';
import { eventRoutes } from './routes-events.js';
import { subscriptionRoutes } from './routes-subscriptions.js';

export function integrationRoutes(
  store: AasStore,
  deps: IntegrationRouteDeps,
  builders: IntegrationRouteBuilders = integrationRouteBuilders(),
): Route[] {
  return [
    ...eventRoutes(store, deps),
    ...subscriptionRoutes(store, deps),
    // Composition points — filled when WP2 and WP4 are merged
    ...(builders.equipment?.(store, deps) ?? []),
    ...(builders.opcua?.(store, deps) ?? []),
    ...(builders.exports?.(store, deps) ?? []),
    ...(builders.externalRefs?.(store, deps) ?? []),
  ];
}
