/**
 * Helpers shared by the integration configuration and OPC UA routes: the admin-session check (D11), optimistic locking
 * with If-Match, validation error responses, audit events and reading the stored configurations.
 */
import { randomBytes } from 'node:crypto';
import {
  defaultServerIntegrationConfig,
  EVENT_TYPES,
  parsePackageIntegrationConfig,
  parseServerIntegrationConfig,
  tr,
  type AuditAction,
  type ConfigError,
  type IntegrationAuditData,
  type PackageIntegrationConfig,
  type ServerIntegrationConfig,
} from '@aas/core';
import { ForbiddenError, type AasStore, type IntegrationStore } from '@aas/store';
import { ApiError, json, type ApiRequest, type ApiResponse } from '../http.js';
import { base32Encode } from './ids.js';

/** The store the integration routes need — `AasStore` once the integration port is merged into it (WP1) */
export type IntegrationRouteStore = AasStore & IntegrationStore;

/**
 * Admin **session** only (D11): an API key with full access and an open server (no accounts) are refused. Integration
 * settings change what the server sends where; that decision belongs to a named person.
 */
export function requireAdminSession(request: ApiRequest): void {
  if (request.principal?.role === 'admin') return;
  if (!request.principal) throw new ApiError(403, 'Forbidden', tr('연동 설정은 관리자 계정으로 로그인해야 바꿀 수 있습니다. 관리자 계정이 없으면 먼저 만드십시오.'));
  throw new ApiError(403, 'Forbidden', tr('연동 설정은 관리자만 바꿀 수 있습니다.'));
}

/** `If-Match: "3"` / `W/"3"` / `3` → 3. Undefined when absent */
export function ifMatchRevision(request: ApiRequest): number | undefined {
  const header = request.headers['if-match'];
  if (header === undefined || header.trim() === '') return undefined;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header);
  if (!match) throw new ApiError(400, 'BadRequest', tr('If-Match 헤더는 "3"처럼 따옴표로 감싼 리비전 번호여야 합니다.'));
  return Number(match[1]);
}

export function requireRevision(request: ApiRequest): number {
  const revision = ifMatchRevision(request);
  if (revision === undefined) {
    throw new ApiError(428, 'PreconditionRequired', tr('If-Match 헤더가 필요합니다. 먼저 읽은 리비전 번호를 "3"처럼 따옴표로 감싸 주십시오.'));
  }
  return revision;
}

/** 400 listing every validation error with its JSON Pointer */
export function invalid(errors: readonly ConfigError[]): ApiResponse {
  const timestamp = new Date().toISOString();
  return json(400, {
    messages: errors.map((error) => ({ code: 'BadRequest', messageType: 'Error', text: `${error.path} ${error.message}`, timestamp })),
    errors,
  });
}

export function withEtag(response: ApiResponse, revision: number): ApiResponse {
  return { ...response, headers: { ...response.headers, etag: `"${revision}"` } };
}

/**
 * Records an `integration.audit` event (admins see it in the feed).
 * Important: never put secrets or URLs with credentials into `details`.
 * Important: inside a private workspace the scoped store refuses event writes (server-only state); the change itself
 *    has happened by then, so a refused audit write must not turn the response into an error.
 */
export async function recordAudit(
  store: Pick<IntegrationStore, 'appendEvents'>,
  request: ApiRequest,
  action: AuditAction,
  target: string,
  details: Record<string, unknown>,
  packageId?: string,
): Promise<void> {
  const data: IntegrationAuditData = {
    action,
    target,
    ...(request.principal ? { actor: { id: request.principal.userId, name: request.principal.displayName } } : {}),
    details,
  };
  try {
    await store.appendEvents([
      {
        // Audit events are facts of their own, never re-derived — a random id, like model events
        id: `evt_${base32Encode(randomBytes(17)).slice(0, 26)}`,
        type: EVENT_TYPES.integrationAudit,
        time: new Date().toISOString(),
        ...(packageId === undefined ? {} : { packageId }),
        ...(request.principal ? { actorId: request.principal.userId, actorName: request.principal.displayName } : {}),
        data,
      },
    ]);
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
  }
}

/** Stored server config, parsed — defaults with `revision: 0` when never saved */
export async function readServerConfig(store: Pick<IntegrationStore, 'getServerIntegrationConfig'>): Promise<{ value: ServerIntegrationConfig; revision: number }> {
  const stored = await store.getServerIntegrationConfig();
  if (!stored) return { value: defaultServerIntegrationConfig(), revision: 0 };
  const parsed = parseServerIntegrationConfig(stored.value);
  // A stored value that does not parse any more keeps its revision, so the next PUT can replace it
  return { value: parsed.ok ? parsed.value : defaultServerIntegrationConfig(instanceIdOf(stored.value)), revision: stored.revision };
}

export function instanceIdOf(value: unknown): string {
  const id = (value as { instanceId?: unknown } | undefined)?.instanceId;
  return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) ? id : '';
}

/** Stored package config, parsed — null when never saved (or no longer parseable) */
export async function readPackageConfig(
  store: Pick<IntegrationStore, 'getPackageIntegrationConfig'>,
  packageId: string,
): Promise<{ value: PackageIntegrationConfig | null; revision: number }> {
  const stored = await store.getPackageIntegrationConfig(packageId);
  if (!stored) return { value: null, revision: 0 };
  const parsed = parsePackageIntegrationConfig(stored.value);
  return { value: parsed.ok ? parsed.value : null, revision: stored.revision };
}
