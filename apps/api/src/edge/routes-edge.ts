/**
 * The three signed endpoints of the edge contract (docs/edge-contract.md): register, read list, batches.
 *
 * They are answered **before** the server's login and API-key check (api.ts): an edge has no session and no API key —
 * its signature is its identity. Everything after the signature runs inside the device's workspace, so a device reads
 * and writes only what its workspace shows.
 *
 * Important: values never go into the AAS. Accepted samples are appended to the value store, referencing package,
 *    interface and property, exactly like the server's own collector (types.ts in @aas/collector — Option A).
 * Important: only approved tags are stored. A sample for a tag that is not in the approved list is refused one by one
 *    (`rejected[]`), never stored — a device cannot widen what it collects on its own.
 */
import { runInWorkspace, type AasStore, type CollectedValue } from '@aas/store';
import { tr } from '@aas/core';
import type { ApiRequest, ApiResponse } from '../http.js';
import { checkSchema } from '../integration/schema-check.js';
import { EDGE_SCHEMAS } from './schemas.js';
import { publicKeyOf, signedHeaders, signedText, SignatureVerifier, type SignedHeaders } from './signature.js';
import type { EdgeDevice, EdgeRegistry } from './state.js';
import type { ReadListInterface } from './read-list.js';

export interface EdgeLimits {
  maxBatchBytes: number;
  maxSamplesPerBatch: number;
  requestsPerMinute: number;
}

export interface EdgeOptions {
  registry: EdgeRegistry;
  /** The workspace-scoped store — every read and write runs inside the device's workspace */
  store: AasStore;
  limits?: Partial<EdgeLimits>;
  pollSeconds?: number;
  serverVersion: string;
  now?: () => number;
}

export const DEFAULT_LIMITS: EdgeLimits = { maxBatchBytes: 1_048_576, maxSamplesPerBatch: 5_000, requestsPerMinute: 60 };
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

export function createEdgeHandler(options: EdgeOptions): (request: ApiRequest) => Promise<ApiResponse> {
  const now = options.now ?? Date.now;
  const verifier = new SignatureVerifier(now);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const pollSeconds = options.pollSeconds ?? 60;
  const recent = new Map<string, number[]>();

  const pathAndQuery = (request: ApiRequest): string => {
    const query = new URLSearchParams(request.queryAll ? Object.entries(request.queryAll).flatMap(([k, vs]) => vs.map((v) => [k, v])) : Object.entries(request.query)).toString();
    return query === '' ? request.path : `${request.path}?${query}`;
  };

  /** The device and its verified signature, or the error answer */
  async function authenticate(request: ApiRequest): Promise<EdgeDevice | ApiResponse> {
    const headers = signedHeaders(request.headers);
    if (!headers) return edgeError(401, 'SignatureInvalid', tr('서명 헤더가 없거나 형식이 맞지 않습니다.'));
    const device = await options.registry.device(headers.device);
    const key = device ? publicKeyOf(device.publicKey) : undefined;
    if (!device || !key) return edgeError(401, 'UnknownDevice', tr('등록되지 않은 장치입니다.'));
    const failure = verifier.check(key, signedText(request.method, pathAndQuery(request), headers, request.rawBody), headers);
    if (failure === 'ClockSkew') return edgeError(401, 'ClockSkew', tr('요청 시각이 서버 시계와 300초 넘게 다릅니다.'));
    if (failure) return edgeError(401, 'SignatureInvalid', tr('서명이 맞지 않습니다.'));
    if (device.revokedAt) return edgeError(403, 'DeviceRevoked', tr('해지된 장치입니다.'));
    return device;
  }

  /** Requests in the last minute, per device. The answer when over the limit */
  function throttle(deviceId: string): ApiResponse | undefined {
    const at = now();
    const window = (recent.get(deviceId) ?? []).filter((t) => t > at - 60_000);
    if (window.length >= limits.requestsPerMinute) {
      recent.set(deviceId, window);
      return edgeError(429, 'RateLimited', tr('이 장치의 요청이 너무 많습니다.'), Math.max(1, Math.ceil((window[0]! + 60_000 - at) / 1000)));
    }
    window.push(at);
    recent.set(deviceId, window);
    return undefined;
  }

  async function register(request: ApiRequest): Promise<ApiResponse> {
    const body = request.body as Record<string, unknown> | undefined;
    if (checkSchema(EDGE_SCHEMAS['register-request']!, body).length > 0) return edgeError(422, 'SchemaMismatch', tr('등록 요청이 규격과 맞지 않습니다.'));
    const input = body as { code: string; publicKey: string; device: { name: string; hostname?: string; software: { name: string; version: string } } };
    const key = publicKeyOf(input.publicKey);
    if (!key) return edgeError(400, 'BadRequest', tr('publicKey 는 32바이트 Ed25519 공개키(base64url)여야 합니다.'));
    const headers = signedHeaders(request.headers) as SignedHeaders | undefined;
    if (!headers || headers.device !== 'register') return edgeError(401, 'SignatureInvalid', tr('등록 요청은 X-Edge-Device: register 로 서명해야 합니다.'));
    const failure = verifier.check(key, signedText(request.method, pathAndQuery(request), headers, request.rawBody), headers);
    if (failure === 'ClockSkew') return edgeError(401, 'ClockSkew', tr('요청 시각이 서버 시계와 300초 넘게 다릅니다.'));
    if (failure) return edgeError(401, 'SignatureInvalid', tr('서명이 맞지 않습니다.'));
    const created = await options.registry.register(input.code, {
      publicKey: input.publicKey,
      name: input.device.name,
      ...(input.device.hostname ? { hostname: input.device.hostname } : {}),
      software: { name: input.device.software.name, version: input.device.software.version },
    });
    if (created === undefined) return edgeError(401, 'RegistrationCodeInvalid', tr('등록 코드가 맞지 않거나, 이미 쓰였거나, 만료되었습니다.'));
    if (created === 'key-taken') return edgeError(409, 'KeyAlreadyRegistered', tr('이 공개키는 이미 등록되어 있습니다.'));
    return ok(201, {
      schema: 'vexplor.edge.registration/1',
      deviceId: created.deviceId,
      registeredAt: created.registeredAt,
      server: { tool: 'VEXPLOR AAS Studio', version: options.serverVersion, contract: 'vexplor.edge/1' },
      limits,
      readList: { path: '/edge/v1/read-list', pollSeconds },
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
        pollSeconds,
        interfaces: served.interfaces,
      },
      { etag },
    );
  }

  async function batch(request: ApiRequest, device: EdgeDevice): Promise<ApiResponse> {
    if ((request.rawBody?.length ?? 0) > limits.maxBatchBytes) return edgeError(413, 'PayloadTooLarge', tr('묶음이 크기 상한을 넘었습니다.'));
    const body = request.body as Record<string, unknown> | undefined;
    if (checkSchema(EDGE_SCHEMAS['batch']!, body).length > 0) return edgeError(422, 'SchemaMismatch', tr('묶음이 규격과 맞지 않습니다.'));
    const input = body as { bootId: string; seq: number; samples: { tagId: string; observedAt: string; receivedAt: string; value: unknown; quality?: string }[] };
    if (input.samples.length > limits.maxSamplesPerBatch) return edgeError(413, 'PayloadTooLarge', tr('묶음의 값 개수가 상한을 넘었습니다.'));

    const served = servedList(device);
    const tags = new Map(served.interfaces.flatMap((iface) => iface.tags.map((tag) => [tag.tagId, { iface, tag }] as const)));
    const rejected: { index: number; tagId: string; code: string }[] = [];
    const byPackage = new Map<string, CollectedValue[]>();
    input.samples.forEach((sample, index) => {
      const found = tags.get(sample.tagId);
      if (!found) {
        rejected.push({ index, tagId: sample.tagId, code: device.state === 'approved' ? 'UnknownTag' : 'NotApproved' });
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
      };
      byPackage.set(value.packageId, [...(byPackage.get(value.packageId) ?? []), value]);
    });
    const accepted = input.samples.length - rejected.length;
    const stored = await options.registry.once(device.deviceId, input.bootId, input.seq, async () => {
      for (const [packageId, values] of byPackage) await options.store.appendValues(packageId, values);
    });
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
    const limited = throttle(device.deviceId);
    if (limited) return limited;
    return runInWorkspace(deviceWorkspace(device), () => (isList ? readList(request, device) : batch(request, device)));
  };
}
