/**
 * Test helpers for the integration API (WP3) — stores, injected services, a route-level caller with a chosen
 * principal, a local receiver, and the scenario event builders the schema test validates (`SCENARIO_BUILDERS`).
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { EVENT_TYPES, type EventType } from '@aas/core';
import { InMemoryStore, type AasStore, type StoredEvent } from '@aas/store';

import { toErrorResponse } from '../../src/api.js';
import type { ApiRequest } from '../../src/http.js';
import { compile, match } from '../../src/router.js';
import type { IntegrationAasStore, IntegrationRouteDeps, IntegrationServices } from '../../src/integration/deps.js';
import { egressPolicyFromEnv } from '../../src/integration/egress.js';
import { integrationRoutes } from '../../src/integration/routes.js';
import { SecretBox } from '../../src/integration/secrets.js';
import { projectionScenario } from './integration-projection.js';
import { runtimeEventScenario } from './integration-runtime.js';

export const KEY = Buffer.alloc(32, 7);

export async function memoryStore(now?: () => string): Promise<InMemoryStore & IntegrationAasStore> {
  const store = new InMemoryStore(now);
  await store.init();
  return store;
}

/** A controllable clock in epoch ms */
export function clock(start = '2026-10-14T00:00:00.000Z'): { now: () => number; iso: () => string; advance: (ms: number) => void } {
  let at = Date.parse(start);
  return { now: () => at, iso: () => new Date(at).toISOString(), advance: (ms) => void (at += ms) };
}

/** Services with an injected resolver (no DNS) and allowlist */
export function testServices(options: {
  allow?: string;
  resolve?: Record<string, string[]>;
  now?: () => number;
  secrets?: SecretBox | undefined;
  storeKind?: IntegrationServices['storeKind'];
  demo?: boolean;
  enabled?: boolean;
} = {}): IntegrationServices {
  const answers = options.resolve ?? {};
  return {
    instanceId: async () => '9f2c4e1a7b3d',
    storeKind: options.storeKind ?? 'memory',
    egress: egressPolicyFromEnv({ AAS_INTEGRATION_ALLOW: options.allow ?? '' }, options.demo ?? false, async (host) => {
      const found = answers[host];
      if (!found) throw new Error(`ENOTFOUND ${host}`);
      return found;
    }),
    secrets: 'secrets' in options ? options.secrets : new SecretBox(KEY),
    masterKey: 'env',
    now: options.now ?? Date.now,
    status: () => ({ enabled: options.enabled ?? false, running: [], demo: options.demo ?? false }),
    opcua: () => ({ security: 'off' }),
  };
}

export type Principal = NonNullable<ApiRequest['principal']>;
export const ADMIN: Principal = { userId: 'user_1', login: 'admin', role: 'admin', displayName: 'Admin', visitor: 'v1' };
export const EDITOR: Principal = { userId: 'user_2', login: 'editor', role: 'editor', displayName: 'Editor', visitor: 'v2' };
export const VIEWER: Principal = { userId: 'user_3', login: 'viewer', role: 'viewer', displayName: 'Viewer', visitor: 'v3' };

export interface Reply {
  status: number;
  headers: Record<string, string>;
  /**
   * Kept as `any` on purpose: the integration tests read ~55 nested JSON paths of many response shapes
   * (`reply.body.items[0].data.n`); typing each with `unknown` + casts would bury the assertions. Same convention as the
   * existing API tests (`body as any` in registry.test.ts and others). Production code has no `any`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  body: any;
}

/**
 * Calls the integration routes directly (route level, like api.ts does after authentication), with `principal`
 * already resolved. Permission rules **inside** the routes are what this exercises; api.ts authentication is tested
 * through createApi separately.
 */
export function routeCaller(store: AasStore, deps: IntegrationRouteDeps) {
  const routes = compile(integrationRoutes(store, deps));
  return async (
    method: string,
    rawPath: string,
    options: { body?: unknown; principal?: Principal; headers?: Record<string, string> } = {},
  ): Promise<Reply> => {
    const [path, queryText] = rawPath.split('?') as [string, string | undefined];
    const query = Object.fromEntries(new URLSearchParams(queryText ?? ''));
    const request: ApiRequest = {
      method,
      path,
      query,
      headers: options.headers ?? {},
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.principal ? { principal: options.principal } : {}),
    };
    const found = match(routes, method, path);
    if (found === undefined || found === 'method-not-allowed') return { status: found ? 405 : 404, headers: {}, body: undefined };
    try {
      const response = await found.route.handle({ request, params: found.params });
      return { status: response.status, headers: response.headers, body: response.body };
    } catch (error) {
      const response = toErrorResponse(error);
      return { status: response.status, headers: response.headers, body: response.body };
    }
  };
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * A local HTTP receiver on 127.0.0.1:0. `respond` decides each answer; every request is recorded. Loopback is never
 * reachable through the egress policy, so tests give the subscription a public-looking host and pin the connection
 * to 127.0.0.1 through the injected `send`.
 */
export async function startReceiver(
  respond: (request: ReceivedRequest, index: number) => { status: number; headers?: Record<string, string>; body?: string } | 'hang',
): Promise<{ port: number; requests: ReceivedRequest[]; close: () => Promise<void> }> {
  const requests: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const received = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(received);
      const answer = respond(received, requests.length - 1);
      if (answer === 'hang') return;
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── Scenario events ────────────────────────────────────────────────────────────

const ASSET = {
  globalAssetId: 'https://example.com/ids/asset/press-03',
  aasId: 'https://example.com/ids/aas/press-03',
  packageId: 'pkg_12',
  assetKind: 'Instance',
  serialNumber: 'SN-2024-00317',
  specificAssetIds: [{ name: 'mesResourceId', value: 'PRS-03' }],
  externalRefs: [{ system: 'mes:plant', type: 'equipmentCode', id: 'PRS-03' }],
  path: ['ACME', 'Plant', 'Line-A', 'Pressing', 'Press-03'],
  isa95: { enterprise: 'ACME', site: 'Plant', area: 'Line-A', workCenter: 'Pressing', workUnit: 'Press-03' },
};

const SOURCE = {
  interfaceName: 'PLC1',
  propertyName: 'MachineState',
  address: 'opc.tcp://user:***@10.0.0.5:4840',
  submodelId: 'https://example.com/ids/sm/OperationalData',
  idShortPath: 'MachineState',
  semanticId: null,
  observableReference: {
    type: 'ModelReference',
    keys: [
      { type: 'Submodel', value: 'https://example.com/ids/sm/OperationalData' },
      { type: 'Property', value: 'MachineState' },
    ],
  },
  simulated: false,
};

const AT = '2026-10-14T01:41:07.300Z';

/** `data` of every type as the design documents it (§2.3) — a WP3-side example per type */
export const SAMPLE_DATA: Record<EventType, Record<string, unknown>> = {
  [EVENT_TYPES.modelPackageCreated]: { packageId: 'pkg_12', name: 'Press-03.aasx', owner: null, globalAssetId: ASSET.globalAssetId, aasId: ASSET.aasId, counts: { AssetAdministrationShell: 1, Submodel: 9, ConceptDescription: 120 } },
  [EVENT_TYPES.modelPackageDeleted]: { packageId: 'pkg_12', name: 'Press-03.aasx', globalAssetId: ASSET.globalAssetId, aasId: ASSET.aasId },
  [EVENT_TYPES.modelPackageFileChanged]: { packageId: 'pkg_12', part: '/aasx/files/manual.pdf', role: 'supplementary', operation: 'put' },
  [EVENT_TYPES.modelShellCreated]: modelData('AssetAdministrationShell', 'create'),
  [EVENT_TYPES.modelShellUpdated]: modelData('AssetAdministrationShell', 'update'),
  [EVENT_TYPES.modelShellDeleted]: modelData('AssetAdministrationShell', 'delete'),
  [EVENT_TYPES.modelSubmodelCreated]: modelData('Submodel', 'create'),
  [EVENT_TYPES.modelSubmodelUpdated]: modelData('Submodel', 'update'),
  [EVENT_TYPES.modelSubmodelDeleted]: modelData('Submodel', 'delete'),
  [EVENT_TYPES.modelConceptDescriptionCreated]: modelData('ConceptDescription', 'create'),
  [EVENT_TYPES.modelConceptDescriptionUpdated]: modelData('ConceptDescription', 'update'),
  [EVENT_TYPES.modelConceptDescriptionDeleted]: modelData('ConceptDescription', 'delete'),
  [EVENT_TYPES.modelExternalRefsUpdated]: { packageId: 'pkg_12', revision: 3 },
  [EVENT_TYPES.equipmentMasterChanged]: { asset: ASSET, operation: 'updated', changedKeys: ['nameplate.serialNumber'], revision: 37, projectionHash: 'sha256:00', href: '/integrations/exports/equipment?format=json&packageId=pkg_12' },
  [EVENT_TYPES.equipmentBomChanged]: { asset: ASSET, operation: 'created', revision: 37, projectionHash: 'sha256:00', href: '/integrations/exports/bom?format=json&packageId=pkg_12' },
  [EVENT_TYPES.equipmentMaintenanceChanged]: { asset: ASSET, operation: 'updated', revision: 37, projectionHash: 'sha256:00', href: '/integrations/exports/maintenance?packageId=pkg_12' },
  [EVENT_TYPES.equipmentDocumentsChanged]: { asset: { ...ASSET, pathAmbiguous: true }, operation: 'removed', revision: 37, projectionHash: 'sha256:00', href: '/integrations/exports/documents?packageId=pkg_12' },
  [EVENT_TYPES.equipmentStateChanged]: { asset: ASSET, source: SOURCE, state: 'alarm', previousState: 'run', previousStateSince: AT, previousDurationMs: 1707310, rawValue: '3', ruleSetHash: 'sha256:9a1c', observedAt: AT, receivedAt: AT, quality: 'Good', detectionResolutionMs: 30000, suppressed: false },
  [EVENT_TYPES.equipmentAlarmRaised]: alarmData(null),
  [EVENT_TYPES.equipmentAlarmCleared]: alarmData(AT),
  [EVENT_TYPES.equipmentCounterAdvanced]: { asset: ASSET, source: SOURCE, counterId: 'produced', counterKind: 'total', unit: null, from: 15230, to: 15241, delta: 11, intervalStart: AT, intervalEnd: AT, flags: { reset: false, rollover: false, implausible: false, gap: false }, excludedBadSamples: 0 },
  [EVENT_TYPES.equipmentThresholdCrossed]: thresholdData(),
  [EVENT_TYPES.equipmentThresholdReturned]: thresholdData(),
  [EVENT_TYPES.collectionConnectionLost]: { asset: { ...ASSET, globalAssetId: null, aasId: null, assetKind: null, isa95: null }, interfaceName: 'OPCUA_Main', protocol: 'OPCUA', endpoint: 'opc.tcp://192.168.0.50:4840', error: 'connect ECONNREFUSED', since: AT, consecutiveFailures: 2, simulated: false },
  [EVENT_TYPES.collectionConnectionRestored]: { asset: ASSET, interfaceName: 'OPCUA_Main', protocol: 'OPCUA', endpoint: 'opc.tcp://192.168.0.50:4840', error: null, since: AT, consecutiveFailures: 0, simulated: true },
  [EVENT_TYPES.integrationAudit]: { action: 'subscription.created', target: 'sub_1', actor: { id: 'user_1', name: 'Admin' }, details: { name: 'MES' } },
  [EVENT_TYPES.integrationPing]: { subscriptionId: 'sub_1', serverTime: AT, message: 'VEXPLOR AAS Studio test delivery' },
};

function modelData(modelType: string, operation: string): Record<string, unknown> {
  return {
    packageId: 'pkg_12',
    modelType,
    id: `https://example.com/ids/${modelType}/1`,
    idShort: 'TechnicalData',
    semanticId: null,
    operation,
    identifiableRevision: operation === 'delete' ? null : 5,
    packageRevision: 37,
    globalAssetId: ASSET.globalAssetId,
    aasId: ASSET.aasId,
    actor: { id: 'user_3', name: 'Kim' },
  };
}

function alarmData(clearedAt: string | null): Record<string, unknown> {
  return {
    asset: ASSET, source: SOURCE, alarmRuleId: 'alarm-main', alarmInstanceId: 'alm_0123456789ABCDEFGHJKMNPQRS', code: 'E-217', text: 'Hydraulic pressure low',
    severity: null, raisedAt: AT, detectedAt: AT, clearedAt, durationMs: clearedAt ? 5000 : null, occurrences: 1, maintenanceIds: [], detectionResolutionMs: 30000, suppressed: false,
  };
}

function thresholdData(): Record<string, unknown> {
  return { asset: ASSET, source: SOURCE, thresholdId: 'motor-temp-high', direction: 'above', limit: 85, hysteresis: 2, value: 86.4, unit: 'degC', severity: null, observedAt: AT, detectedAt: AT, suppressed: false };
}

/** A stored row of `type` with the sample data — for rendering and schema tests */
export function sampleRow(type: EventType, seq = 1): StoredEvent {
  const data = structuredClone(SAMPLE_DATA[type]);
  const model = type.includes('.model.');
  return {
    seq,
    id: `evt_${String(seq).padStart(26, '0')}`,
    type,
    time: AT,
    recordedAt: AT,
    packageId: 'pkg_12',
    ...(model ? { packageRevision: 37, cause: 'edit', changeSetId: 'chg_5f1d0c2e5f1d0c2e', actorId: 'user_3', actorName: 'Kim' } : { subject: ASSET.globalAssetId }),
    data,
  };
}

/**
 * Scenario builders of the other work packages — each returns the stored events its scenarios produce; the schema
 * test validates every one against the published schema.
 */
export const SCENARIO_BUILDERS: { name: string; build: () => Promise<StoredEvent[]> }[] = [
  { name: 'runtime (detector)', build: runtimeEventScenario },
  { name: 'projection (projector)', build: projectionScenario },
];
