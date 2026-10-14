/**
 * Integration configuration and runtime equipment data routes (docs/design/integration-v1.md §4.3, §4.6):
 *
 *   GET/PUT /integrations/config                         server state rules, time zone, day start, shifts (PUT: admin)
 *   GET/PUT /packages/:packageId/integration-config      per-package state tag, alarms, counters, thresholds (PUT: edit)
 *   GET     /integrations/equipment/segments             state segments and totals over a window
 *   GET     /integrations/equipment/oee-inputs           durations and counts for OEE — never an OEE number
 *   GET     /integrations/meters                         CMMS meter readings per hour / shift / day
 *
 * Writes use optimistic locking with `If-Match: "<revision>"` (428 without it, 412 when stale) — two people editing the
 * rules at once must not silently overwrite each other.
 * None of these routes needs the integration workers, so they also answer when `INTEGRATIONS` is off.
 */
import { randomBytes } from 'node:crypto';
import { effectiveStateRules, fill, freshWindowMs, parsePackageIntegrationConfig, parseServerIntegrationConfig, RESERVED_COUNTER_ID, tr, type ServerIntegrationConfig } from '@aas/core';
import { parseAid } from '@aas/collector';
import { ConflictError, type AasStore } from '@aas/store';
import { ApiError, errorResponse, json, type ApiRequest, type ApiResponse } from '../http.js';
import type { Route } from '../router.js';
import type { IntegrationRouteDeps } from './deps.js';
import {
  instanceIdOf,
  invalid,
  readPackageConfig,
  readServerConfig,
  recordAudit,
  requireAdminSession,
  requireRevision,
  withEtag,
  type IntegrationRouteStore,
} from './route-support.js';
import { deviceCounterReadings, runTimeReadings, type MeterContext } from './runtime/meters.js';
import { computeOeeInputs } from './runtime/oee.js';
import { computeSegments, ruleSetHash, ValueLimitError } from './runtime/segments.js';
import { dayWindow, isDay, periodsBetween, shiftWindow } from './runtime/zoned.js';

export { readPackageConfig, readServerConfig, type IntegrationRouteStore } from './route-support.js';

export interface EquipmentRouteOptions {
  /** Test seam — the routes otherwise use the system clock */
  now?: () => number;
  /** Heavy reads (segments, OEE inputs, meters) running at once; more answer 503 with Retry-After. Default 2 */
  maxConcurrent?: number;
  /** Most periods one meter request may cover. Default MAX_PERIODS */
  maxPeriods?: number;
}

/** Most periods one meter request may cover (31 days of hours is 744) */
export const MAX_PERIODS = 1000;

const MAX_WINDOW_MS = 31 * 24 * 3_600_000;

function instant(request: ApiRequest, name: string): number {
  const text = request.query[name];
  if (text === undefined || text === '') throw new ApiError(400, 'BadRequest', fill(tr('{0} 값이 필요합니다.'), { 0: name }));
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) throw new ApiError(400, 'BadRequest', fill(tr('{0}은(는) ISO 8601 시각이어야 합니다: {1}'), { 0: name, 1: text }));
  return ms;
}

function windowFromQuery(request: ApiRequest): { start: number; end: number } {
  const start = instant(request, 'from');
  const end = instant(request, 'to');
  if (end <= start) throw new ApiError(400, 'BadRequest', tr('to는 from보다 뒤여야 합니다.'));
  if (end - start > MAX_WINDOW_MS) throw new ApiError(400, 'BadRequest', tr('조회 기간은 31일 이하여야 합니다.'));
  return { start, end };
}

function requiredPackageId(request: ApiRequest): string {
  const packageId = request.query['packageId'];
  if (!packageId) throw new ApiError(400, 'BadRequest', tr('packageId 값이 필요합니다.'));
  return packageId;
}

async function existingPackage(store: AasStore, packageId: string): Promise<void> {
  // Through the (scoped) store — a package of another workspace answers 404 exactly like a missing one
  if (!(await store.getPackage(packageId))) {
    throw new ApiError(404, 'NotFound', fill(tr('패키지 {0}을(를) 찾을 수 없습니다.'), { 0: packageId }));
  }
}

function noStateTag(packageId: string): ApiError {
  return new ApiError(409, 'NoStateTag', fill(tr('패키지 {0}의 연동 설정에 상태 태그가 없습니다. 먼저 상태 태그를 고르십시오.'), { 0: packageId }));
}

// ── Routes ─────────────────────────────────────────────────────────────────────

export function equipmentRoutes(store: IntegrationRouteStore, deps: IntegrationRouteDeps, options: EquipmentRouteOptions = {}): Route[] {
  const now = options.now ?? Date.now;
  const holdMs = freshWindowMs(deps.collectIntervalMs);
  const maxConcurrent = options.maxConcurrent ?? 2;
  let running = 0;

  /**
   * Runs a heavy read (review M6): at most `maxConcurrent` at once — the rest are told to retry instead of queueing up
   * memory — and a window holding more values than one request may load becomes a 422 with a clear message.
   */
  async function heavy(work: () => Promise<ApiResponse>): Promise<ApiResponse> {
    if (running >= maxConcurrent) {
      const busy = errorResponse(503, 'Busy', tr('설비 데이터 조회가 이미 여러 건 진행 중입니다. 잠시 뒤 다시 시도하십시오.'));
      return { ...busy, headers: { ...busy.headers, 'retry-after': '5' } };
    }
    running += 1;
    try {
      return await work();
    } catch (error) {
      if (error instanceof ValueLimitError) {
        throw new ApiError(422, 'TooManyValues', fill(tr('이 기간에 저장된 값이 {0}개를 넘습니다. 기간을 줄여 다시 조회하십시오.'), { 0: error.limit }));
      }
      throw error;
    } finally {
      running -= 1;
    }
  }

  return [
    {
      method: 'GET',
      pattern: '/integrations/config',
      async handle() {
        const { value, revision } = await readServerConfig(store);
        // Never saved: show the instance id the server already uses for event sources
        const shown = value.instanceId === '' && deps.services ? { ...value, instanceId: await deps.services.instanceId() } : value;
        return withEtag(json(200, { value: shown, revision }), revision);
      },
    },
    {
      method: 'PUT',
      pattern: '/integrations/config',
      async handle({ request }) {
        requireAdminSession(request);
        const expected = requireRevision(request);
        const parsed = parseServerIntegrationConfig(request.body);
        if (!parsed.ok) return invalid(parsed.errors);
        const current = await store.getServerIntegrationConfig();
        // instanceId is server-owned: whatever the body says, the stored one stays (or is created once, here)
        const value: ServerIntegrationConfig = { ...parsed.value, instanceId: instanceIdOf(current?.value) || (deps.services ? await deps.services.instanceId() : randomBytes(6).toString('hex')) };
        let saved;
        try {
          saved = await store.putServerIntegrationConfig(value, expected);
        } catch (error) {
          if (error instanceof ConflictError) throw new ApiError(412, 'PreconditionFailed', tr('그사이에 다른 사람이 설정을 바꿨습니다. 다시 읽은 뒤 고치십시오.'));
          throw error;
        }
        await recordAudit(deps.auditStore ?? store, request, 'config.updated', 'server', { revision: saved.revision, ruleSetHash: ruleSetHash(value.stateRules) });
        return withEtag(json(200, { value, revision: saved.revision }), saved.revision);
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/integration-config',
      async handle({ params }) {
        const packageId = params['packageId']!;
        await existingPackage(store, packageId);
        const { value, revision } = await readPackageConfig(store, packageId);
        return withEtag(json(200, { value, revision }), revision);
      },
    },
    {
      method: 'PUT',
      pattern: '/packages/:packageId/integration-config',
      async handle({ request, params }) {
        const packageId = params['packageId']!;
        await existingPackage(store, packageId);
        const expected = requireRevision(request);
        const parsed = parsePackageIntegrationConfig(request.body);
        if (!parsed.ok) return invalid(parsed.errors);
        let saved;
        try {
          saved = await store.putPackageIntegrationConfig(packageId, parsed.value, expected);
        } catch (error) {
          if (error instanceof ConflictError) throw new ApiError(412, 'PreconditionFailed', tr('그사이에 다른 사람이 설정을 바꿨습니다. 다시 읽은 뒤 고치십시오.'));
          throw error;
        }
        deps.runtime?.reloadPackageConfig?.(packageId);
        await recordAudit(deps.auditStore ?? store, request, 'config.updated', `packages/${packageId}`, { revision: saved.revision }, packageId);
        return withEtag(json(200, { value: parsed.value, revision: saved.revision }), saved.revision);
      },
    },
    {
      method: 'GET',
      pattern: '/integrations/equipment/segments',
      handle: ({ request }) => heavy(async () => {
        const packageId = requiredPackageId(request);
        const window = windowFromQuery(request);
        await existingPackage(store, packageId);
        const config = (await readPackageConfig(store, packageId)).value;
        if (!config?.state) throw noStateTag(packageId);
        const rules = effectiveStateRules((await readServerConfig(store)).value, config);
        const end = Math.min(window.end, now());
        const result = end > window.start ? await computeSegments(store, packageId, config.state, rules, window.start, end, holdMs) : { segments: [], totals: { run: 0, stop: 0, alarm: 0, off: 0, unknown: 0, none: 0 } };
        return json(200, {
          packageId,
          property: config.state.property,
          ruleSetHash: ruleSetHash(rules),
          holdMs,
          segments: result.segments.map((segment) => ({ from: new Date(segment.from).toISOString(), to: new Date(segment.to).toISOString(), state: segment.state })),
          totals: result.totals,
        });
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/equipment/oee-inputs',
      handle: ({ request }) => heavy(async () => {
        const packageId = requiredPackageId(request);
        const server = (await readServerConfig(store)).value;
        let window: { start: number; end: number };
        const day = request.query['day'];
        if (day !== undefined) {
          if (!isDay(day)) throw new ApiError(400, 'BadRequest', fill(tr('day는 YYYY-MM-DD 형식이어야 합니다: {0}'), { 0: day }));
          const shiftName = request.query['shift'];
          if (shiftName !== undefined) {
            const shift = server.shifts.find((candidate) => candidate.name === shiftName);
            if (!shift) throw new ApiError(400, 'BadRequest', fill(tr('설정에 없는 교대입니다: {0}'), { 0: shiftName }));
            window = shiftWindow(server.timezone, day, shift);
          } else window = dayWindow(server.timezone, day, server.dayStartHour);
        } else window = windowFromQuery(request);
        await existingPackage(store, packageId);
        const config = (await readPackageConfig(store, packageId)).value;
        if (!config?.state) throw noStateTag(packageId);
        const rules = effectiveStateRules(server, config);
        // A window reaching into the future is measured up to now — the rest has no data yet and is not "no data"
        const end = Math.max(window.start, Math.min(window.end, now()));
        const inputs = await computeOeeInputs(store, packageId, config, rules, { start: window.start, end, timezone: server.timezone }, holdMs, deps.collectIntervalMs ?? null);
        return json(200, inputs);
      }),
    },
    {
      method: 'GET',
      pattern: '/integrations/meters',
      handle: ({ request }) => heavy(async () => {
        const packageId = requiredPackageId(request);
        const counter = request.query['counter'];
        if (!counter) throw new ApiError(400, 'BadRequest', tr('counter 값이 필요합니다(카운터 ID 또는 runtime).'));
        const period = request.query['period'] ?? 'day';
        if (period !== 'hour' && period !== 'shift' && period !== 'day') {
          throw new ApiError(400, 'BadRequest', fill(tr('period는 다음 중 하나여야 합니다: {0}'), { 0: 'hour, shift, day' }));
        }
        const window = windowFromQuery(request);
        await existingPackage(store, packageId);
        const config = (await readPackageConfig(store, packageId)).value;
        const server = (await readServerConfig(store)).value;
        if (period === 'shift' && server.shifts.length === 0) throw new ApiError(400, 'BadRequest', tr('교대가 설정되어 있지 않습니다.'));
        const environment = await store.getEnvironment(packageId);
        const firstShell = environment.assetAdministrationShells?.[0];
        const context: MeterContext = {
          store,
          packageId,
          assetId: firstShell?.assetInformation?.globalAssetId ?? packageId,
          environment,
          interfaces: parseAid(environment),
          holdMs,
          now: now(),
        };
        // Not clipped to now: an unfinished period must keep its real end so the run-time meter can leave it out
        const periods = periodsBetween(server.timezone, window.start, window.end, period, server.dayStartHour, server.shifts);
        const maxPeriods = options.maxPeriods ?? MAX_PERIODS;
        if (periods.length > maxPeriods) {
          throw new ApiError(422, 'TooManyPeriods', fill(tr('한 번에 {0}개가 넘는 기간은 조회할 수 없습니다. 기간을 줄이거나 더 긴 단위를 고르십시오.'), { 0: maxPeriods }));
        }
        let readings;
        if (counter === RESERVED_COUNTER_ID) {
          if (!config?.state) throw noStateTag(packageId);
          readings = await runTimeReadings(context, config.state, effectiveStateRules(server, config), periods);
        } else {
          const rule = config?.counters.find((candidate) => candidate.id === counter);
          if (!rule) throw new ApiError(404, 'NotFound', fill(tr('연동 설정에 없는 카운터입니다: {0}'), { 0: counter }));
          readings = await deviceCounterReadings(context, rule, periods);
        }
        return json(200, { readings });
      }),
    },
  ];
}
