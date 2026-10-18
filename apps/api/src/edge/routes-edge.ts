/**
 * The three signed endpoints of the edge contract (docs/edge-contract.md): register, read list, batches.
 *
 * They are answered **before** the server's login and API-key check (api.ts): an edge has no session and no API key —
 * its signature is its identity. Everything after the signature runs inside the device's workspace, so a device reads
 * and writes only what its workspace owns.
 *
 * Important: values never go into the AAS. Accepted samples are appended to the value store, referencing package,
 *    interface and property, exactly like the server's own collector (types.ts in @aas/collector — Option A).
 * Important: only approved tags of owned, existing files are stored, checked sample by sample before anything is
 *    written — so a batch is stored whole or not at all, and a retry never stores part of it twice (review H1).
 * Important: registration is rate-limited before its signature is checked — an attacker signs with a key of their own,
 *    so the signature always verifies and cannot be the first gate (review H3).
 */
import { fill, tr } from '@aas/core';
import { runInWorkspace, type AasStore, type CollectedValue } from '@aas/store';
import type { ApiRequest, ApiResponse } from '../http.js';
import { checkSchema } from '../integration/schema-check.js';
import { ownedBy, type ReadListInterface } from './read-list.js';
import { EDGE_SCHEMAS } from './schemas.js';
import { publicKeyOf, signedHeaders, signedText, SignatureVerifier } from './signature.js';
import type { EdgeDevice, EdgeRegistry } from './state.js';

export interface EdgeLimits {
  maxBatchBytes: number;
  maxSamplesPerBatch: number;
  requestsPerMinute: number;
}

export interface EdgeOptions {
  registry: EdgeRegistry;
  /** The workspace-scoped store — every read and write runs inside the device's workspace */
  store: AasStore;
  /** The server splits workspaces — then a device without one (registered before the split) is refused */
  partitioned?: boolean;
  limits?: Partial<EdgeLimits>;
  pollSeconds?: number;
  serverVersion: string;
  now?: () => number;
}

export const DEFAULT_LIMITS: EdgeLimits = { maxBatchBytes: 1_048_576, maxSamplesPerBatch: 5_000, requestsPerMinute: 60 };
/** Registration attempts per minute — per remote address, and for the whole server */
const REGISTER_PER_ADDRESS = 10;
const REGISTER_PER_SERVER = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_TYPES = new Set(['number', 'float', 'double', 'integer', 'int', 'decimal']);
const RETRYABLE = new Set(['ClockSkew', 'RateLimited', 'Unavailable', 'ServerError']);

export function edgeError(status: number, code: string, message: string, retryAfterSeconds?: number): ApiResponse {
  const body = {
    schema: 'vexplor.edge.error/1',
    code,
    message,
    retryable: RETRYABLE.has(code),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
  return {
    status,
    headers: { 'content-type': 'application/json', ...(retryAfterSeconds !== undefined ? { 'retry-after': String(retryAfterSeconds) } : {}) },
    body,
  };
}

const ok = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

/** The device's view of the store: its own workspace, never "sees all" (state.ts) */
export const deviceWorkspace = (device: EdgeDevice) => (device.workspace === null ? undefined : { key: device.workspace, seesAll: false });

/** Read list revision and interfaces as the device should see them now */
export function servedList(device: EdgeDevice): { revision: string; interfaces: ReadListInterface[] } {
  if (device.state === 'approved' && device.approved) return { revision: device.approved.revision, interfaces: device.approved.interfaces };
  // Paused and pending lists are empty; their revision still differs from every approved one, so the edge refetches
  return { revision: device.state === 'paused' ? `paused-${device.approved?.revision ?? '0'}` : '0', interfaces: [] };
}

/** Requests per minute, per key — the answer when over the limit */
class Window {
  private readonly recent = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  take(key: string, perMinute: number): number | undefined {
    const at = this.now();
    const window = (this.recent.get(key) ?? []).filter((t) => t > at - 60_000);
    if (window.length >= perMinute) {
      this.recent.set(key, window);
      return Math.max(1, Math.ceil((window[0]! + 60_000 - at) / 1000));
    }
    window.push(at);
    this.recent.set(key, window);
    return undefined;
  }
}

type Sample = { tagId: string; observedAt: string; receivedAt: string; value: unknown; quality?: string; error?: string };

/** Why one sample cannot be stored, or undefined */
function sampleProblem(sample: Sample, tagType: string | undefined): string | undefined {
  if (!Number.isFinite(Date.parse(sample.observedAt)) || !Number.isFinite(Date.parse(sample.receivedAt))) return 'BadTime';
  if ((sample.quality?.length ?? 0) > 64 || (sample.error?.length ?? 0) > 512) return 'TooLong';
  if (typeof sample.value === 'string' && sample.value.length > 4096) return 'TooLong';
  const type = tagType?.toLowerCase();
  if (sample.value !== null && type && NUMERIC_TYPES.has(type) && typeof sample.value !== 'number') return 'TypeMismatch';
  if (sample.value !== null && type === 'boolean' && typeof sample.value !== 'boolean') return 'TypeMismatch';
  return undefined;
}

class Revoked extends Error {}

export function createEdgeHandler(options: EdgeOptions): (request: ApiRequest) => Promise<ApiResponse> {
  const now = options.now ?? Date.now;
  const verifier = new SignatureVerifier(now);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const pollSeconds = options.pollSeconds ?? 60;
  /** A device waiting for a person asks more often — the approval reaches it within seconds, not a minute (2.7.0) */
  const PENDING_POLL_SECONDS = 10;
  const pollFor = (state: string): number => (state === 'pending-approval' ? Math.min(pollSeconds, PENDING_POLL_SECONDS) : pollSeconds);
  const perDevice = new Window(now);
  const registrations = new Window(now);

  /** The request target as sent; rebuilt only for in-process callers that have none */
  const target = (request: ApiRequest): string => {
    if (request.rawTarget) return request.rawTarget;
    const query = new URLSearchParams(request.query).toString();
    return query === '' ? request.path : `${request.path}?${query}`;
  };

  /** The device and its verified signature, or the error answer */
  async function authenticate(request: ApiRequest): Promise<EdgeDevice | ApiResponse> {
    const headers = signedHeaders(request.headers);
    if (!headers) return edgeError(401, 'SignatureInvalid', tr('서명 헤더가 없거나 형식이 맞지 않습니다.'));
    const device = await options.registry.device(headers.device);
    const key = device ? publicKeyOf(device.publicKey) : undefined;
    if (!device || !key) return edgeError(401, 'UnknownDevice', tr('등록되지 않은 장치입니다.'));
    const failure = verifier.check(key, signedText(request.method, target(request), headers, request.rawBody), headers);
    if (failure === 'ClockSkew') return edgeError(401, 'ClockSkew', tr('요청 시각이 서버 시계와 300초 넘게 다릅니다.'));
    if (failure) return edgeError(401, 'SignatureInvalid', tr('서명이 맞지 않습니다.'));
    if (device.revokedAt) return edgeError(403, 'DeviceRevoked', tr('해지된 장치입니다.'));
    if (options.partitioned && device.workspace === null) {
      return edgeError(403, 'DeviceRevoked', tr('작업 공간을 나누기 전에 등록된 장치입니다 — 새 코드로 다시 등록하십시오.'));
    }
    return device;
  }

  async function register(request: ApiRequest): Promise<ApiResponse> {
    const wait = registrations.take(`addr:${request.remoteAddress ?? '-'}`, REGISTER_PER_ADDRESS) ?? registrations.take('server', REGISTER_PER_SERVER);
    if (wait !== undefined) return edgeError(429, 'RateLimited', tr('등록 요청이 너무 많습니다.'), wait);
    const body = request.body as Record<string, unknown> | undefined;
    if (checkSchema(EDGE_SCHEMAS['register-request']!, body).length > 0) return edgeError(422, 'SchemaMismatch', tr('등록 요청이 규격과 맞지 않습니다.'));
    const input = body as { code: string; publicKey: string; device: { name: string; hostname?: string; software: { name: string; version: string } } };
    const key = publicKeyOf(input.publicKey);
    if (!key) return edgeError(400, 'BadRequest', tr('publicKey 는 32바이트 Ed25519 공개키(base64url)여야 합니다.'));
    // A code that cannot register is refused before the signature check and the lock — junk costs one memory lookup
    if (!(await options.registry.codeLooksValid(input.code))) {
      return edgeError(401, 'RegistrationCodeInvalid', tr('등록 코드가 맞지 않거나, 이미 쓰였거나, 만료되었습니다.'));
    }
    const headers = signedHeaders(request.headers);
    if (!headers || headers.device !== 'register') return edgeError(401, 'SignatureInvalid', tr('등록 요청은 X-Edge-Device: register 로 서명해야 합니다.'));
    const failure = verifier.check(key, signedText(request.method, target(request), headers, request.rawBody), headers);
    if (failure === 'ClockSkew') return edgeError(401, 'ClockSkew', tr('요청 시각이 서버 시계와 300초 넘게 다릅니다.'));
    if (failure) return edgeError(401, 'SignatureInvalid', tr('서명이 맞지 않습니다.'));
    const created = await options.registry.register(input.code, {
      publicKey: input.publicKey,
      name: input.device.name.slice(0, 200),
      ...(input.device.hostname ? { hostname: input.device.hostname.slice(0, 200) } : {}),
      software: { name: input.device.software.name.slice(0, 100), version: input.device.software.version.slice(0, 50) },
    });
    if (created === undefined) return edgeError(401, 'RegistrationCodeInvalid', tr('등록 코드가 맞지 않거나, 이미 쓰였거나, 만료되었습니다.'));
    if (created === 'key-taken') return edgeError(409, 'KeyAlreadyRegistered', tr('이 공개키는 이미 등록되어 있습니다.'));
    return ok(201, {
      schema: 'vexplor.edge.registration/1',
      deviceId: created.deviceId,
      registeredAt: created.registeredAt,
      server: { tool: 'VEXPLOR AAS Studio', version: options.serverVersion, contract: 'vexplor.edge/1' },
      limits,
      readList: { path: '/edge/v1/read-list', pollSeconds: pollFor(created.state) },
    });
  }

  function readList(request: ApiRequest, device: EdgeDevice): ApiResponse {
    const served = servedList(device);
    const etag = `"${served.revision}"`;
    if (request.headers['if-none-match'] === etag) return { status: 304, headers: { etag }, body: undefined };
    return ok(
      200,
      {
        schema: 'vexplor.edge.readList/1',
        deviceId: device.deviceId,
        revision: served.revision,
        state: device.state,
        approvedAt: device.state === 'approved' ? (device.approved?.approvedAt ?? null) : null,
        pollSeconds: pollFor(device.state),
        interfaces: served.interfaces,
      },
      { etag },
    );
  }

  async function batch(request: ApiRequest, device: EdgeDevice): Promise<ApiResponse> {
    if ((request.rawBody?.length ?? 0) > limits.maxBatchBytes) return edgeError(413, 'PayloadTooLarge', tr('묶음이 크기 상한을 넘었습니다.'));
    const body = request.body as Record<string, unknown> | undefined;
    if (checkSchema(EDGE_SCHEMAS['batch']!, body).length > 0) return edgeError(422, 'SchemaMismatch', tr('묶음이 규격과 맞지 않습니다.'));
    const input = body as { bootId: string; seq: number; samples: Sample[]; status?: Record<string, unknown> };
    if (!UUID.test(input.bootId)) return edgeError(422, 'SchemaMismatch', tr('bootId 는 UUID 여야 합니다.'));
    if (input.samples.length > limits.maxSamplesPerBatch) return edgeError(413, 'PayloadTooLarge', tr('묶음의 값 개수가 상한을 넘었습니다.'));

    const served = servedList(device);
    const tags = new Map(served.interfaces.flatMap((iface) => iface.tags.map((tag) => [tag.tagId, { iface, tag }] as const)));
    // Every package the batch would write: it must still exist and be owned by the device's workspace
    const writable = new Map<string, boolean>();
    for (const { iface } of tags.values()) {
      if (!writable.has(iface.packageId)) writable.set(iface.packageId, ownedBy(device.workspace, await options.store.getPackage(iface.packageId)));
    }
    const rejected: { index: number; tagId: string; code: string }[] = [];
    const byPackage = new Map<string, CollectedValue[]>();
    input.samples.forEach((sample, index) => {
      const found = tags.get(sample.tagId);
      const problem = !found
        ? device.state === 'approved' ? 'UnknownTag' : 'NotApproved'
        : !writable.get(found.iface.packageId) ? 'PackageUnavailable' : sampleProblem(sample, found.tag.type);
      if (problem || !found) {
        rejected.push({ index, tagId: sample.tagId.slice(0, 100), code: problem ?? 'UnknownTag' });
        return;
      }
      const value: CollectedValue = {
        packageId: found.iface.packageId,
        interfaceName: found.iface.interfaceName,
        propertyName: found.tag.propertyName,
        source: found.tag.address,
        observedAt: sample.observedAt,
        receivedAt: sample.receivedAt,
        ...(typeof sample.value === 'number' ? { valueNumber: sample.value } : {}),
        ...(typeof sample.value === 'string' || typeof sample.value === 'boolean' ? { valueText: String(sample.value) } : {}),
        ...(sample.quality !== undefined ? { quality: sample.quality } : {}),
        // Why the edge could not read it (2.8.0) — Modbus and MQTT have no quality, so without this the row was only empty
        ...(sample.error !== undefined && sample.error !== '' ? { error: sample.error } : {}),
        // The store skips a key it already has — a crash after storing and before recording the batch cannot double it
        key: `edge:${device.deviceId}:${input.bootId}:${input.seq}:${index}`,
      };
      byPackage.set(value.packageId, [...(byPackage.get(value.packageId) ?? []), value]);
    });
    const accepted = input.samples.length - rejected.length;
    const stored = await options.registry.once(device.deviceId, input.bootId, input.seq, async () => {
      // Revoked while this request waited for the lock — store nothing (review L)
      if ((await options.registry.device(device.deviceId))?.revokedAt) throw new Revoked();
      for (const [packageId, values] of byPackage) await options.store.appendValues(packageId, values);
    });
    // For the screen: when it last sent, how many values, and what it said about its connections
    await options.registry.recordActivity(device.deviceId, stored ? accepted : 0, input.status);
    return ok(200, {
      schema: 'vexplor.edge.batchResult/1',
      bootId: input.bootId,
      seq: input.seq,
      accepted: stored ? accepted : 0,
      duplicate: !stored,
      rejected: stored ? rejected : [],
      readListRevision: served.revision,
    });
  }

  return async (request) => {
    if (request.method === 'POST' && request.path === '/edge/v1/register') return register(request);
    const isList = request.method === 'GET' && request.path === '/edge/v1/read-list';
    const isBatch = request.method === 'POST' && request.path === '/edge/v1/batches';
    if (!isList && !isBatch) return edgeError(404, 'BadRequest', tr('엣지 규격에 없는 경로입니다.'));
    const device = await authenticate(request);
    if (!('deviceId' in device)) return device;
    const wait = perDevice.take(device.deviceId, limits.requestsPerMinute);
    if (wait !== undefined) return edgeError(429, 'RateLimited', tr('이 장치의 요청이 너무 많습니다.'), wait);
    try {
      return await runInWorkspace(deviceWorkspace(device), () => (isList ? readList(request, device) : batch(request, device)));
    } catch (error) {
      if (error instanceof Revoked) return edgeError(403, 'DeviceRevoked', tr('해지된 장치입니다.'));
      throw error;
    }
  };
}

/** Any other answer inside the edge handler, in the edge error envelope (api.ts) — the edge reads only that shape */
export function edgeErrorFrom(answer: ApiResponse): ApiResponse {
  const text = (answer.body as { messages?: { text?: string }[] } | undefined)?.messages?.[0]?.text ?? fill(tr('오류 {0}'), { 0: answer.status });
  if (answer.status === 413) return edgeError(413, 'PayloadTooLarge', text);
  if (answer.status >= 500) return edgeError(500, 'ServerError', tr('서버 오류입니다 — 같은 묶음을 다시 보내십시오.'));
  return edgeError(answer.status === 404 || answer.status === 403 ? 422 : answer.status, 'BadRequest', text);
}
