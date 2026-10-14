/**
 * Small helpers shared by the WP3 integration routes: permission checks (D11), query parsing, audit events and the
 * default services used when the server did not boot integrations (tests calling createApi directly).
 */
import { randomBytes } from 'node:crypto';

import { EVENT_TYPES, fill, tr, type AuditAction } from '@aas/core';

import { ApiError, errorResponse, type ApiRequest, type ApiResponse } from '../http.js';
import type { IntegrationAasStore, IntegrationRouteDeps, IntegrationServices } from './deps.js';
import { egressPolicyFromEnv } from './egress.js';
import { base32Encode } from './ids.js';
import { SecretBox } from './secrets.js';
import { randomInstanceId } from './store-port.js';

/**
 * Subscriptions make this server connect outward — on an open server that is an SSRF and exfiltration relay. So only
 * an admin **session** manages them: not editors, not full API keys, not an open server without accounts.
 */
export function requireAdmin(request: ApiRequest): void {
  if (request.principal?.role === 'admin') return;
  if (!request.principal && request.headers['authorization'] === undefined) {
    throw new ApiError(403, 'Forbidden', tr('연동 구독은 관리자만 다룹니다 — 먼저 관리자 계정을 만들고 로그인하십시오.'));
  }
  throw new ApiError(403, 'Forbidden', tr('연동 구독은 관리자 계정으로 로그인해야 다룰 수 있습니다.'));
}

export function isAdminSession(request: ApiRequest): boolean {
  return request.principal?.role === 'admin';
}

/** A non-negative integer query value, or the fallback when absent; 400 otherwise */
export function integerParam(request: ApiRequest, name: string, fallback: number, min: number, max: number): number {
  const raw = request.query[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new ApiError(400, 'BadRequest', fill(tr('{0}은(는) {1}~{2} 사이의 정수여야 합니다.'), { 0: name, 1: min, 2: max }));
  }
  return value;
}

/** Error body with extra top-level fields (410 `oldestSeq`, 422 `reason`) next to the usual `messages` */
export function errorWith(status: number, code: string, text: string, extra: Record<string, unknown>): ApiResponse {
  const base = errorResponse(status, code, text);
  return { ...base, body: { ...(base.body as Record<string, unknown>), code, ...extra } };
}

export function newEventId(): string {
  return `evt_${base32Encode(randomBytes(17)).slice(0, 26)}`;
}

/**
 * Appends one `integration.audit.v1` event (feed-only, admins). `details` must never hold secrets or URLs with
 * credentials — callers pass stripped URLs only.
 */
export async function audit(
  store: Pick<IntegrationAasStore, 'appendEvents'>,
  request: ApiRequest,
  action: AuditAction,
  target: string,
  details: Record<string, unknown>,
  now: number,
): Promise<void> {
  const actor = request.principal ? { id: request.principal.userId, name: request.principal.displayName } : undefined;
  await store.appendEvents([
    {
      id: newEventId(),
      type: EVENT_TYPES.integrationAudit,
      time: new Date(now).toISOString(),
      ...(actor ? { actorId: actor.id, actorName: actor.name } : {}),
      data: { action, target, ...(actor ? { actor } : {}), details },
    },
  ]);
}

let fallback: IntegrationServices | undefined;

/**
 * Services for a server that did not call startIntegrations (tests, the coverage script). Workers are off, the master
 * key lives only in this process, DNS is real and nothing is allowlisted — so nothing private is ever reachable.
 */
export function defaultIntegrationServices(): IntegrationServices {
  if (fallback) return fallback;
  const instanceId = randomInstanceId();
  const status = { enabled: false, reason: tr('INTEGRATIONS=on이 아닙니다 — 이벤트 기록과 피드만 동작합니다.'), running: [] };
  fallback = {
    instanceId: async () => instanceId,
    storeKind: 'memory',
    egress: egressPolicyFromEnv({}, false),
    secrets: new SecretBox(randomBytes(32)),
    masterKey: 'ephemeral',
    now: Date.now,
    status: () => status,
    opcua: () => ({ security: 'off', running: false }),
  };
  return fallback;
}

export function servicesOf(deps: IntegrationRouteDeps): IntegrationServices {
  return deps.services ?? defaultIntegrationServices();
}

/** Workers that send need `INTEGRATIONS=on` — answered as 503 with the hint */
export function requireRuntime(deps: IntegrationRouteDeps): NonNullable<IntegrationRouteDeps['runtime']> {
  // `runtime` itself is present also when the workers are off (status, OPC UA trust store) — ask for a worker member
  if (deps.runtime?.testSubscription) return deps.runtime;
  throw new ApiError(503, 'IntegrationsOff', tr('연동이 꺼져 있습니다 — 서버를 INTEGRATIONS=on으로 띄우십시오.'));
}
