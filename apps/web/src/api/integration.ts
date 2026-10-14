/**
 * API client — MES / ERP / CMMS integration (docs/design/integration-v1.md §4).
 *
 * Built against the API contract, not a running server: every response type here mirrors §4 and the store records
 * of §3.1 (the web package does not depend on @aas/store, so the shapes are restated). Fields the server may leave
 * out are optional so an older or newer server degrades instead of crashing the screen.
 *
 * Important: this file has its own request helper instead of `request()` from http.ts. The integration screens need
 *    the error **code** (`TargetNotAllowed`, `IntegrationsOff`, `BomRootMismatch`, …) and extra body fields
 *    (`claims` on 409, `oldestSeq` on 410), which `request()` throws away after taking the message text.
 * Important: optimistic locking uses `If-Match: "<revision>"` with the quotes (an entity tag). The server answers 428
 *    when it is missing and 412 when it is stale — callers turn 412 into a "reload" prompt, never a silent retry.
 */
import type { CloudEvent, PackageIntegrationConfig, ServerIntegrationConfig } from '@aas/core';
import { fill, tr } from '../i18n.js';
import { ApiError, filenameOf, saveBlob, withAuth } from './http.js';

// ── Errors ──────────────────────────────────────────────────────────────────

/** A failed integration request with the server's error code and the parsed body (for claims, oldestSeq, …) */
export class IntegrationError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(status, message);
  }
}

/** 412 — someone else saved first; the caller offers a reload */
export const isStale = (caught: unknown): boolean => caught instanceof IntegrationError && caught.status === 412;
/** 404 on an /integrations path — the server is older than the integration release (no such routes) */
export const isMissingRoute = (caught: unknown): boolean => caught instanceof ApiError && caught.status === 404;

interface ErrorBody {
  messages?: { code?: string; text?: string }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withAuth(init));
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      /* Not JSON — a proxy or an old server in front */
    }
    const message = (body as ErrorBody | undefined)?.messages?.[0];
    const text = message?.text ?? (response.status === 404 ? tr('이 서버에는 연동 기능이 없습니다 — 연동이 들어간 판으로 올리십시오.') : `${response.status} ${response.statusText}`);
    throw new IntegrationError(response.status, text, message?.code, body);
  }
  if (response.status === 204) return undefined as T;
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new IntegrationError(response.status, fill(tr('API 응답이 아닙니다 ({0}) — 개발 서버 프록시(vite.config.ts)에 이 경로가 빠져 있습니다.'), { 0: path }));
  }
  return (await response.json()) as T;
}

const json = (method: string, body: unknown, revision?: number): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(revision === undefined ? {} : { 'if-match': ifMatch(revision) }) },
  body: JSON.stringify(body),
});

/** Entity tag for a revision — quoted, as HTTP requires */
export function ifMatch(revision: number): string {
  return `"${revision}"`;
}

/** Query string from defined values only — `undefined`, `false` and '' are left out */
export function query(values: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value === true ? '1' : String(value))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

const enc = encodeURIComponent;

// ── Shapes (§4) ─────────────────────────────────────────────────────────────

export interface Versioned<T> {
  value: T;
  revision: number;
}

/** GET /integrations/status (§4.2). Older drafts sent only enabled/reason/running, so most fields are optional */
export interface IntegrationStatusView {
  enabled: boolean;
  demo?: boolean;
  reason?: string;
  running?: string[];
  instanceId?: string;
  serverTime?: string;
  workers?: {
    dispatcher?: { running: boolean; lastFanoutAt?: string; cursor?: string | number };
    projector?: { running: boolean; lastFlushAt?: string; cursor?: string | number };
    detector?: { enabled: boolean; lastCycleAt?: string };
  };
  backlog?: { pending: number; oldestPendingAt?: string; dead: number };
  egress?: { allow: string[]; blockedPorts?: number[] };
  masterKey?: 'env' | 'file' | 'ephemeral' | 'missing';
  opcua?: { security: 'secure' | 'insecure' | 'off'; pki?: string };
}

export type SubscriptionKind = 'webhook' | 'mqtt';
export type DeliveryStatus = 'pending' | 'in-flight' | 'succeeded' | 'dead';

export interface DeliveryStatsView {
  subscriptionId?: string;
  pending: number;
  inFlight: number;
  dead: number;
  succeeded: number;
  oldestPendingAt?: string;
}

export interface SubscriptionView {
  id: string;
  name: string;
  kind: SubscriptionKind;
  url: string;
  types: string[];
  packageIds: string[];
  enabled: boolean;
  disabledReason?: string;
  options: { topicPrefix?: string; retainState?: boolean };
  secretHint: string;
  consecutiveDead: number;
  lastSuccessAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  stats?: DeliveryStatsView;
}

export interface SubscriptionInput {
  name: string;
  kind: SubscriptionKind;
  url: string;
  types: string[];
  packageIds?: string[];
  enabled?: boolean;
  options?: { topicPrefix?: string; retainState?: boolean };
}

export interface DeliveryView {
  id: string;
  subscriptionId: string;
  eventSeq: number | string;
  eventId: string;
  type?: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastStatusCode?: number;
  lastError?: string;
  lastDurationMs?: number;
  lastAddress?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  ok: boolean;
  statusCode?: number;
  durationMs?: number;
  address?: string;
  responseSnippet?: string;
  serverTime?: string;
  error?: string;
}

export const EXPORT_KINDS = ['equipment', 'bom', 'hierarchy', 'maintenance', 'documents'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportOptions {
  /** Required for every kind except equipment (absent = every visible file) */
  packageId?: string;
  format: 'json' | 'csv';
  /** CSV: UTF-8 byte order mark for Excel */
  bom?: boolean;
  /** CSV: Korean column labels instead of the frozen keys */
  koreanHeaders?: boolean;
  /** Equipment: include Type shells (flagged) */
  includeTypes?: boolean;
  lang?: string;
}

export interface ReadinessCheck {
  id: string;
  severity: 'warning' | 'error';
  message: string;
  pointer?: string;
}

export interface ReadinessView {
  items: { packageId: string; checks: ReadinessCheck[] }[];
}

export interface ExternalRef {
  system: string;
  type: string;
  id: string;
  publish?: boolean;
  sensitive?: boolean;
  externalSubjectId?: string;
  syncedAt?: string;
  source?: string;
}

export type ExternalRefSubjectKey =
  | { kind: 'asset'; globalAssetId: string }
  | { kind: 'bomChild'; globalAssetId: string }
  | { kind: 'consumable' | 'tool'; globalAssetId: string; key: string };

export interface ExternalRefsDoc {
  schema: 'vexplor.externalRefs/1';
  subjects: { subject: ExternalRefSubjectKey; refs: ExternalRef[] }[];
  managedSpecificAssetIds?: string[];
}

export interface RefClaim {
  system: string;
  type: string;
  id: string;
  packageId: string;
  subject: string;
}

export interface RefImportResult {
  changes: { packageId: string; add: ExternalRef[]; remove: ExternalRef[] }[];
  errors: { row: number; message: string }[];
  conflicts: RefClaim[];
  revisions?: Record<string, number>;
}

export interface OpcuaCertificate {
  thumbprint: string;
  subject?: string;
  notAfter?: string;
}

export interface EventPageView {
  items: CloudEvent[];
  nextAfter: string;
  oldestSeq: string | null;
  serverTime: string;
}

/** 409 body of PUT external-refs — `claims` may sit at the top level or inside the message */
export function claimsOf(caught: unknown): RefClaim[] {
  if (!(caught instanceof IntegrationError) || caught.status !== 409) return [];
  const body = caught.body as { claims?: RefClaim[]; messages?: { claims?: RefClaim[] }[] } | undefined;
  return body?.claims ?? body?.messages?.[0]?.claims ?? [];
}

// ── URLs ────────────────────────────────────────────────────────────────────

export function exportPath(kind: ExportKind, options: ExportOptions): string {
  return `/integrations/exports/${kind}${query({
    packageId: options.packageId,
    format: options.format,
    bom: options.format === 'csv' && options.bom,
    headers: options.format === 'csv' && options.koreanHeaders ? 'ko' : undefined,
    includeTypes: kind === 'equipment' && options.includeTypes,
    lang: options.lang,
  })}`;
}

/** Address an MES / ERP polls — absolute, so it can be pasted into another system's configuration */
export function feedUrl(origin: string, after = 0): string {
  return `${origin.replace(/\/$/, '')}/integrations/events?after=${after}`;
}

// ── Calls ───────────────────────────────────────────────────────────────────

export const integrationApi = {
  status: (): Promise<IntegrationStatusView> => call('/integrations/status'),
  events: (input: { after?: number | string; limit?: number; types?: string[]; packageId?: string } = {}): Promise<EventPageView> =>
    call(`/integrations/events${query({ after: input.after, limit: input.limit, types: input.types?.join(','), packageId: input.packageId })}`),
  schemas: (): Promise<{ types: string[] }> => call('/integrations/schemas'),

  serverConfig: (): Promise<Versioned<ServerIntegrationConfig>> => call('/integrations/config'),
  saveServerConfig: (value: ServerIntegrationConfig, revision: number): Promise<Versioned<ServerIntegrationConfig>> =>
    call('/integrations/config', json('PUT', value, revision)),
  packageConfig: (packageId: string): Promise<Versioned<PackageIntegrationConfig | null>> =>
    call(`/packages/${enc(packageId)}/integration-config`),
  savePackageConfig: (packageId: string, value: PackageIntegrationConfig, revision: number): Promise<Versioned<PackageIntegrationConfig>> =>
    call(`/packages/${enc(packageId)}/integration-config`, json('PUT', value, revision)),

  subscriptions: (): Promise<{ items: SubscriptionView[] }> => call('/integrations/subscriptions'),
  createSubscription: (input: SubscriptionInput): Promise<{ subscription: SubscriptionView; secret: string }> =>
    call('/integrations/subscriptions', json('POST', input)),
  updateSubscription: (id: string, patch: Partial<SubscriptionInput>): Promise<SubscriptionView> =>
    call(`/integrations/subscriptions/${enc(id)}`, json('PATCH', patch)),
  deleteSubscription: (id: string): Promise<void> => call(`/integrations/subscriptions/${enc(id)}`, { method: 'DELETE' }),
  rotateSecret: (id: string): Promise<{ secret: string; previousValidUntil?: string }> =>
    call(`/integrations/subscriptions/${enc(id)}/rotate-secret`, { method: 'POST' }),
  testSubscription: (id: string): Promise<TestResult> => call(`/integrations/subscriptions/${enc(id)}/test`, { method: 'POST' }),
  replay: (id: string, from: { fromSeq: string } | { from: string }): Promise<{ enqueued: number }> =>
    call(`/integrations/subscriptions/${enc(id)}/replay`, json('POST', from)),
  deliveries: (id: string, input: { status?: DeliveryStatus; limit?: number; cursor?: string } = {}): Promise<{ items: DeliveryView[]; cursor?: string }> =>
    call(`/integrations/subscriptions/${enc(id)}/deliveries${query({ status: input.status, limit: input.limit, cursor: input.cursor })}`),
  redeliver: (deliveryId: string): Promise<DeliveryView> => call(`/integrations/deliveries/${enc(deliveryId)}/redeliver`, { method: 'POST' }),

  readiness: (packageId?: string): Promise<ReadinessView> => call(`/integrations/readiness${query({ packageId })}`),
  /** Downloads an export as a file — the name comes from Content-Disposition (the server knows schema and date) */
  downloadExport: async (kind: ExportKind, options: ExportOptions): Promise<string> => {
    const path = exportPath(kind, options);
    const response = await fetch(path, withAuth());
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        /* not JSON */
      }
      const message = (body as ErrorBody | undefined)?.messages?.[0];
      throw new IntegrationError(response.status, message?.text ?? `${response.status} ${response.statusText}`, message?.code, body);
    }
    const name = filenameOf(response) ?? `${kind}.${options.format}`;
    saveBlob(await response.blob(), name);
    return name;
  },

  externalRefs: (packageId: string): Promise<Versioned<ExternalRefsDoc>> => call(`/packages/${enc(packageId)}/external-refs`),
  saveExternalRefs: (
    packageId: string,
    doc: ExternalRefsDoc,
    revision: number,
  ): Promise<Versioned<ExternalRefsDoc> & { projected?: { added: string[]; removed: string[] } }> =>
    call(`/packages/${enc(packageId)}/external-refs`, json('PUT', doc, revision)),
  /** CSV text is sent as text/csv (the server also accepts `{ rows }` JSON) */
  importExternalRefs: (csv: string, dryRun: boolean): Promise<RefImportResult> =>
    call(`/integrations/external-refs/import${query({ dryRun })}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv }),

  opcuaCertificates: (): Promise<{ trusted: OpcuaCertificate[]; rejected: OpcuaCertificate[] }> => call('/integrations/opcua/certificates'),
  trustCertificate: (thumbprint: string): Promise<unknown> =>
    call(`/integrations/opcua/certificates/${enc(thumbprint)}/trust`, { method: 'POST' }),
};
