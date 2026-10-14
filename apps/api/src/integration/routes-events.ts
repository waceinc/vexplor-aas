/**
 * Pull feed and event schemas (docs/design/integration-v1.md §4.1).
 *
 *   GET /integrations/events?after=&limit=&types=&packageId=   any reader, workspace-scoped (the store layer filters)
 *   GET /integrations/schemas                                  the list of event types
 *   GET /integrations/schemas/:type                            one JSON Schema
 *
 * The feed is the totally ordered view: consumers that need order or catch-up use it, webhooks give no order.
 * `after` older than the oldest retained event answers 410 — the consumer then re-reads the exports instead of
 * silently missing what was pruned.
 */
import { fill, isEventType, tr } from '@aas/core';
import type { AasStore } from '@aas/store';

import { ApiError, json } from '../http.js';
import type { Route } from '../router.js';
import { toCloudEvent } from './cloudevents.js';
import type { IntegrationRouteDeps } from './deps.js';
import { settledPrefix } from './ids.js';
import { errorWith, integerParam, isAdminSession, servicesOf } from './route-helpers.js';
import { eventSchema, schemaTypes } from './schemas.js';
import { integrationStore } from './store-port.js';

const MAX_AFTER = Number.MAX_SAFE_INTEGER;

export function eventRoutes(rawStore: AasStore, deps: IntegrationRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/integrations/events',
      async handle({ request }) {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const after = integerParam(request, 'after', 0, 0, MAX_AFTER);
        const limit = integerParam(request, 'limit', 200, 1, 1000);
        const types = (request.query['types'] ?? '')
          .split(',')
          .map((type) => type.trim())
          .filter((type) => type !== '');
        const packageId = request.query['packageId'];
        const page = await store.readEvents({
          after,
          limit,
          ...(types.length > 0 ? { types } : {}),
          ...(packageId ? { packageId } : {}),
          // Audit events tell who changed which subscription — admins only
          includeAudit: isAdminSession(request),
        });
        if (page.oldestSeq !== null && after < page.oldestSeq - 1) {
          return errorWith(
            410,
            'Gone',
            fill(tr('요청한 위치({0}) 이후의 이벤트 일부가 보존 기간이 지나 지워졌습니다. 가장 오래된 이벤트는 {1}번입니다 — 내보내기로 전체를 다시 받으십시오.'), {
              0: after,
              1: page.oldestSeq,
            }),
            { oldestSeq: String(page.oldestSeq) },
          );
        }
        // Only PostgreSQL can make a later seq visible before an earlier one commits (§2.4). Elsewhere gaps are
        // filtered-out rows, and holding them back would only delay the feed
        const now = services.now();
        const rows = services.storeKind === 'postgres' ? settledPrefix(page.items, after, now) : page.items;
        const instanceId = await services.instanceId();
        const items = rows.map((row) =>
          toCloudEvent(row, { instanceId, ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}) }),
        );
        return json(200, {
          items,
          nextAfter: String(rows.length > 0 ? rows[rows.length - 1]!.seq : after),
          oldestSeq: page.oldestSeq === null ? null : String(page.oldestSeq),
          serverTime: new Date(now).toISOString(),
        });
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/schemas',
      handle: async () => json(200, { types: [...schemaTypes()] }),
    },
    {
      method: 'GET',
      pattern: '/integrations/schemas/:type',
      async handle({ params }) {
        const type = params['type']!;
        if (!isEventType(type)) throw new ApiError(404, 'NotFound', fill(tr('알 수 없는 이벤트 종류입니다: {0}'), { 0: type }));
        return json(200, eventSchema(type));
      },
    },
  ];
}
