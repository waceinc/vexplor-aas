/**
 * Subscriptions, deliveries, test delivery and status — admin session only (docs/design/integration-v1.md §4.2, D11).
 *
 * The signing secret is shown **once** (create, rotate) and never again: listings carry only `secretHint`, delivery rows
 * and audit events never contain it. Every URL is checked against the egress policy here (422) and again before each
 * attempt in the dispatcher.
 */
import { fill, tr } from '@aas/core';
import type { AasStore, DeliveryStatus, SubscriptionPatch } from '@aas/store';

import { ApiError, json, noContent } from '../http.js';
import type { Route } from '../router.js';
import type { IntegrationRouteDeps, IntegrationServices } from './deps.js';
import { checkTarget } from './egress.js';
import { audit, errorWith, integerParam, requireAdmin, requireRuntime, servicesOf } from './route-helpers.js';
import { replay, statusReport } from './subscription-ops.js';
import { parseSubscriptionInput, splitCredentials } from './subscription-input.js';
import { newSigningSecret, secretHint } from './secrets.js';
import { integrationStore } from './store-port.js';

const ROTATION_OVERLAP_MS = 24 * 3_600_000;
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'in-flight', 'succeeded', 'dead'];

function requireBox(services: IntegrationServices): NonNullable<IntegrationServices['secrets']> {
  if (services.secrets) return services.secrets;
  throw new ApiError(503, 'MasterKeyMissing', tr('비밀값을 잠글 키가 없습니다 — PostgreSQL을 쓸 때는 AAS_SECRET_KEY를 주고 다시 띄우십시오.'));
}

async function egressOrThrow(url: string, kind: 'webhook' | 'mqtt', services: IntegrationServices): Promise<void> {
  const target = await checkTarget(url, kind, services.egress);
  if (!target.ok) throw new TargetNotAllowed(target.reason);
}

/** 422 with the reason — the admin needs to know whether to fix the URL or the allowlist */
class TargetNotAllowed extends Error {}

export function subscriptionRoutes(rawStore: AasStore, deps: IntegrationRouteDeps): Route[] {
  const guarded = (handle: Route['handle']): Route['handle'] => async (ctx) => {
    requireAdmin(ctx.request);
    try {
      return await handle(ctx);
    } catch (error) {
      if (error instanceof TargetNotAllowed) {
        return errorWith(422, 'TargetNotAllowed', fill(tr('연결할 수 없는 대상입니다: {0}'), { 0: error.message }), { reason: error.message });
      }
      throw error;
    }
  };
  const notFound = (id: string): ApiError => new ApiError(404, 'NotFound', fill(tr('구독을 찾을 수 없습니다: {0}'), { 0: id }));

  return [
    {
      method: 'POST',
      pattern: '/integrations/subscriptions',
      handle: guarded(async ({ request }) => {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const input = parseSubscriptionInput(request.body, 'create');
        const kind = input.kind!;
        const { url, credentials } = splitCredentials(input.url!, kind);
        const box = requireBox(services);
        await egressOrThrow(url, kind, services);
        const secret = newSigningSecret();
        const subscription = await store.createSubscription({
          name: input.name!,
          kind,
          url,
          types: input.types!,
          packageIds: input.packageIds ?? [],
          enabled: input.enabled ?? true,
          options: input.options ?? {},
          secretHint: secretHint(secret),
          ...(request.principal ? { createdBy: request.principal.userId } : {}),
          secrets: {
            keyId: box.keyId,
            secretSealed: box.seal(secret),
            ...(credentials === undefined ? {} : { credentialsSealed: box.seal(credentials) }),
          },
        });
        await audit(deps.auditStore ?? store, request, 'subscription.created', subscription.id, { name: subscription.name, kind, url, types: subscription.types, packageIds: subscription.packageIds }, services.now());
        deps.runtime?.wakeDispatcher?.();
        return json(201, { subscription, secret });
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/subscriptions',
      handle: guarded(async () => {
        const store = integrationStore(rawStore);
        const stats = new Map((await store.deliveryStats()).map((entry) => [entry.subscriptionId, entry]));
        const items = (await store.listSubscriptions()).map((subscription) => ({
          ...subscription,
          stats: stats.get(subscription.id) ?? { subscriptionId: subscription.id, pending: 0, inFlight: 0, dead: 0, succeeded: 0 },
        }));
        return json(200, { items });
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/subscriptions/:id',
      handle: guarded(async ({ params }) => {
        const found = await integrationStore(rawStore).getSubscription(params['id']!);
        if (!found) throw notFound(params['id']!);
        const { secrets: _secrets, ...subscription } = found;
        return json(200, subscription);
      }),
    },
    {
      method: 'PATCH',
      pattern: '/integrations/subscriptions/:id',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const id = params['id']!;
        const current = await store.getSubscription(id);
        if (!current) throw notFound(id);
        const input = parseSubscriptionInput(request.body, 'patch');
        const patch: SubscriptionPatch = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.types !== undefined) patch.types = input.types;
        if (input.packageIds !== undefined) patch.packageIds = input.packageIds;
        if (input.options !== undefined) patch.options = input.options;
        if (input.url !== undefined) {
          const { url, credentials } = splitCredentials(input.url, current.kind);
          await egressOrThrow(url, current.kind, services);
          patch.url = url;
          // New credentials in the URL replace the sealed ones; a URL without userinfo keeps them
          if (credentials !== undefined) patch.secrets = { ...current.secrets, credentialsSealed: requireBox(services).seal(credentials) };
        }
        if (input.enabled !== undefined) {
          patch.enabled = input.enabled;
          if (input.enabled) Object.assign(patch, { disabledReason: undefined, consecutiveDead: 0 });
        }
        const updated = await store.updateSubscription(id, patch);
        if (!updated) throw notFound(id);
        await audit(deps.auditStore ?? store, request, 'subscription.updated', id, { changed: Object.keys(input).sort(), url: updated.url }, services.now());
        deps.runtime?.subscriptionChanged?.(id);
        deps.runtime?.wakeDispatcher?.();
        return json(200, updated);
      }),
    },
    {
      method: 'DELETE',
      pattern: '/integrations/subscriptions/:id',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const id = params['id']!;
        const current = await store.getSubscription(id);
        if (!current || !(await store.deleteSubscription(id))) throw notFound(id);
        await audit(deps.auditStore ?? store, request, 'subscription.deleted', id, { name: current.name, url: current.url }, servicesOf(deps).now());
        deps.runtime?.subscriptionChanged?.(id);
        return noContent();
      }),
    },
    {
      method: 'POST',
      pattern: '/integrations/subscriptions/:id/rotate-secret',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const box = requireBox(services);
        const id = params['id']!;
        const current = await store.getSubscription(id);
        if (!current) throw notFound(id);
        const secret = newSigningSecret();
        const previousValidUntil = new Date(services.now() + ROTATION_OVERLAP_MS).toISOString();
        await store.updateSubscription(id, {
          secretHint: secretHint(secret),
          secrets: { ...current.secrets, keyId: box.keyId, secretSealed: box.seal(secret), previousSealed: current.secrets.secretSealed, previousUntil: previousValidUntil },
        });
        await audit(deps.auditStore ?? store, request, 'subscription.secret-rotated', id, { previousValidUntil }, services.now());
        return json(200, { secret, previousValidUntil });
      }),
    },
    {
      method: 'POST',
      pattern: '/integrations/subscriptions/:id/test',
      handle: guarded(async ({ params }) => {
        const runtime = requireRuntime(deps);
        const id = params['id']!;
        if (!(await integrationStore(rawStore).getSubscription(id))) throw notFound(id);
        const result = await runtime.testSubscription?.(id);
        if (!result) throw notFound(id);
        return json(200, result);
      }),
    },
    {
      method: 'POST',
      pattern: '/integrations/subscriptions/:id/replay',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const id = params['id']!;
        const subscription = await store.getSubscription(id);
        if (!subscription) throw notFound(id);
        const { enqueued, echo } = await replay(store, subscription, request.body, services.now());
        await audit(deps.auditStore ?? store, request, 'subscription.replayed', id, { ...echo, enqueued }, services.now());
        deps.runtime?.wakeDispatcher?.();
        return json(200, { enqueued });
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/subscriptions/:id/deliveries',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const id = params['id']!;
        if (!(await store.getSubscription(id))) throw notFound(id);
        const status = request.query['status'];
        if (status !== undefined && !DELIVERY_STATUSES.includes(status as DeliveryStatus)) {
          throw new ApiError(400, 'BadRequest', fill(tr('status는 {0} 중 하나여야 합니다.'), { 0: DELIVERY_STATUSES.join(', ') }));
        }
        const limit = integerParam(request, 'limit', 50, 1, 200);
        const cursor = request.query['cursor'];
        const page = await store.listDeliveries(id, {
          limit,
          ...(status ? { status: status as DeliveryStatus } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const items = [];
        for (const delivery of page.items) {
          const event = (await store.readEvents({ after: delivery.eventSeq - 1, limit: 1, includeAudit: true })).items[0];
          items.push({ ...delivery, type: event?.seq === delivery.eventSeq ? event.type : null });
        }
        return json(200, { items, ...(page.cursor ? { cursor: page.cursor } : {}) });
      }),
    },
    {
      method: 'POST',
      pattern: '/integrations/deliveries/:id/redeliver',
      handle: guarded(async ({ request, params }) => {
        const store = integrationStore(rawStore);
        const services = servicesOf(deps);
        const id = params['id']!;
        if (!(await store.redeliver(id, new Date(services.now()).toISOString()))) {
          throw new ApiError(404, 'NotFound', fill(tr('전송 기록을 찾을 수 없습니다: {0}'), { 0: id }));
        }
        const delivery = (await store.getDelivery(id))!;
        await audit(deps.auditStore ?? store, request, 'delivery.redelivered', id, { subscriptionId: delivery.subscriptionId, eventId: delivery.eventId }, services.now());
        deps.runtime?.wakeDispatcher?.();
        return json(200, delivery);
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/status',
      handle: guarded(async () => json(200, await statusReport(integrationStore(rawStore), deps, servicesOf(deps)))),
    },
  ];
}
