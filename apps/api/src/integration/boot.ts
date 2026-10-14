/**
 * Starting and stopping the integration subsystem (docs/design/integration-v1.md §5.1, D15).
 *
 * - Event recording and the pull feed work always (the store records model events itself).
 * - `INTEGRATIONS=on` starts the dispatcher, the projector (WP4) and the detector (WP2). Demo mode forces it off —
 *   a public trial server must not open outbound connections.
 * - Pruning runs always, hourly: events older than `INTEGRATION_RETENTION_DAYS` (default 30), succeeded deliveries
 *   after 7 days, dead ones after 30.
 * - Signal handling is **not** here: only the `server.js` entry block installs SIGTERM/SIGINT handlers. Library use
 *   (tests creating servers) must never take over the process signals.
 */
import { fill, tr } from '@aas/core';
import type { AasStore } from '@aas/store';

import type { IntegrationComposition, JoinWithInvalidate, ProjectorLike, DetectorLike } from './compose.js';
import type { IntegrationRuntimeDeps, IntegrationServices, IntegrationStatus, OpcUaPki } from './deps.js';
import { Dispatcher, type DispatcherOptions, type TimerHost } from './dispatcher.js';
import { egressPolicyFromEnv, type EgressPolicy } from './egress.js';
import { MqttSink } from './mqtt-sink.js';
import { loadMasterKey, type StoreKind } from './secrets.js';
import { ensureInstanceId, randomInstanceId, supportsIntegration } from './store-port.js';
import { DEFAULT_TIMEOUT_MS } from './webhook.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** WP2's PackageCycle — typed loosely here so the boot compiles before WP2 merges */
export type PackageCycleHook = (cycle: unknown) => Promise<void>;

export interface IntegrationBoot {
  enabled: boolean;
  /**
   * Passed to createApi → routes. Always present: `status` and `opcuaPki` (the OPC UA trust store must be reachable
   * also with INTEGRATIONS off); the worker members (`wakeDispatcher`, `testSubscription`, …) only when the workers run
   */
  runtimeDeps: IntegrationRuntimeDeps;
  /** Passed to createApi → routes, also when the workers are off */
  services: IntegrationServices;
  /** Passed to CollectSupervisor (WP2 hook). Undefined when off or no detector is composed */
  onPackageCycle: PackageCycleHook | undefined;
  status(): IntegrationStatus;
  /** Stops loops, waits ≤ 5 s for sends in flight, closes MQTT connections */
  stop(): Promise<void>;
}

export interface StartIntegrationsOptions {
  store: AasStore;
  env: Record<string, string | undefined>;
  demo: boolean;
  dataDir?: string;
  storeKind: StoreKind;
  publicBaseUrl?: string;
  collectIntervalMs?: number;
  compose?: IntegrationComposition;
  now?: () => number;
  random?: () => number;
  timers?: TimerHost;
  /** Injected in tests instead of DNS */
  resolve?: EgressPolicy['resolve'];
  /** Injected in tests to reach a local receiver (loopback is never an allowed target) */
  send?: DispatcherOptions['send'];
  log?: (line: string) => void;
  /** The OPC UA trust store while the OPC UA server runs in secure mode (server.ts) */
  opcuaPki?: () => OpcUaPki | undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `INTEGRATION_TIMEOUT_MS`, clamped to 1–60 s — the claim lease is derived from it (dispatcher `leaseFor`) */
export function timeoutFromEnv(env: Record<string, string | undefined>): number {
  return Math.min(60_000, Math.max(1_000, positiveNumber(env['INTEGRATION_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS)));
}

function opcuaFromEnv(env: Record<string, string | undefined>, demo: boolean): ReturnType<IntegrationServices['opcua']> {
  if (env['OPCUA_SERVER'] !== 'on' || demo) return { security: 'off' };
  return { security: env['OPCUA_ALLOW_INSECURE'] === 'on' ? 'insecure' : 'secure' };
}

export function startIntegrations(options: StartIntegrationsOptions): IntegrationBoot {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => undefined);
  const egress = egressPolicyFromEnv(options.env, options.demo, options.resolve);
  const masterKey = loadMasterKey({ env: options.env, storeKind: options.storeKind, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const supported = supportsIntegration(options.store);
  const wanted = options.env['INTEGRATIONS'] === 'on';
  const enabled = wanted && !options.demo && supported;
  const reason = !wanted
    ? tr('INTEGRATIONS=on이 아닙니다 — 이벤트 기록과 피드만 동작합니다.')
    : options.demo
      ? tr('체험판(DEMO_MODE=on)에서는 연동을 켜지 않습니다.')
      : !supported
        ? tr('이 저장소는 연동 기능을 지원하지 않습니다.')
        : undefined;

  // The instance id is needed synchronously when rendering; resolve it once and keep it
  let instanceId = '';
  const instanceReady: Promise<string> = supported
    ? ensureInstanceId(options.store as Parameters<typeof ensureInstanceId>[0]).catch(() => randomInstanceId())
    : Promise.resolve(randomInstanceId());
  void instanceReady.then((id) => (instanceId = id));

  const timers: { handle?: ReturnType<typeof setInterval> } = {};
  let stopped = false;
  const running: string[] = [];
  let dispatcher: Dispatcher | undefined;
  let projector: ProjectorLike | undefined;
  let detector: DetectorLike | undefined;
  let join: JoinWithInvalidate | undefined;

  const status = (): IntegrationStatus => ({
    enabled,
    ...(reason === undefined ? {} : { reason }),
    running: [...running],
    demo: options.demo,
    workers: {
      dispatcher: dispatcher ? dispatcher.status() : { running: false },
      projector: projector?.status?.() ?? { running: projector !== undefined },
      detector: detector?.status?.() ?? { enabled: detector !== undefined },
    },
  });

  const services: IntegrationServices = {
    instanceId: () => instanceReady,
    storeKind: options.storeKind,
    egress,
    secrets: masterKey.box,
    masterKey: masterKey.source,
    now,
    status,
    opcua: () => opcuaFromEnv(options.env, options.demo),
  };
  if (masterKey.warning) log(masterKey.warning);
  if (masterKey.file) log(fill(tr('웹훅 비밀값을 잠그는 키: {0} — 데이터 폴더 백업에 이 키도 들어갑니다.'), { 0: masterKey.file }));

  if (supported) {
    const store = options.store as Parameters<typeof ensureInstanceId>[0];
    const retentionDays = positiveNumber(options.env['INTEGRATION_RETENTION_DAYS'], 30);
    const prune = async (): Promise<void> => {
      const at = now();
      await store.pruneEvents(new Date(at - retentionDays * DAY_MS).toISOString());
      await store.pruneDeliveries(new Date(at - 7 * DAY_MS).toISOString(), new Date(at - 30 * DAY_MS).toISOString());
    };
    const runPrune = (): void => void prune().catch((error: unknown) => log(fill(tr('연동 기록 정리 실패: {0}'), { 0: String(error) })));
    runPrune();
    timers.handle = setInterval(runPrune, HOUR_MS);
    timers.handle.unref();
  }

  let runtimeDeps: IntegrationRuntimeDeps = { status, ...(options.opcuaPki ? { opcuaPki: options.opcuaPki } : {}) };
  let onPackageCycle: PackageCycleHook | undefined;
  if (enabled) {
    const store = options.store as Parameters<typeof ensureInstanceId>[0];
    const compose = options.compose ?? {};
    const mqtt = compose.mqttConnect ? new MqttSink(compose.mqttConnect, () => instanceId) : undefined;
    dispatcher = new Dispatcher({
      store,
      instanceId: () => instanceId,
      ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
      egress,
      secrets: masterKey.box,
      storeKind: options.storeKind,
      ...(mqtt ? { mqtt } : {}),
      timeoutMs: timeoutFromEnv(options.env),
      now,
      ...(options.random ? { random: options.random } : {}),
      ...(options.timers ? { timers: options.timers } : {}),
      ...(options.send ? { send: options.send } : {}),
    });
    // Start sending only once the instance id is known — every rendered event carries it
    void instanceReady.then(() => {
      if (!stopped) dispatcher?.start();
    });
    running.push('dispatcher');
    if (mqtt) running.push('mqtt');

    join = compose.createJoin?.(store, options.publicBaseUrl);
    if (join && compose.createProjector) {
      projector = compose.createProjector({ store, join, ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}), now });
      projector.start();
      running.push('projector');
    }
    if (join && compose.createDetector) {
      const created = compose.createDetector({ store, join, ...(options.collectIntervalMs ? { collectIntervalMs: options.collectIntervalMs } : {}) });
      detector = created;
      onPackageCycle = async (cycle: unknown) => {
        await created.onPackageCycle(cycle as never);
        // New runtime events are in the log — no need to wait for the next fan-out tick
        dispatcher?.wake();
      };
      running.push('detector');
    }

    const active = dispatcher;
    runtimeDeps = {
      ...runtimeDeps,
      ...(join ? { join } : {}),
      wakeDispatcher: () => active.wake(),
      ...(detector?.reloadPackageConfig ? { reloadPackageConfig: (packageId: string) => detector?.reloadPackageConfig?.(packageId) } : {}),
      ...(projector ? { flushProjection: (packageId?: string) => projector!.flushNow(packageId) } : {}),
      testSubscription: (subscriptionId: string) => active.testPing(subscriptionId),
      subscriptionChanged: (subscriptionId: string) => void mqtt?.forget(subscriptionId),
    };
  }

  return {
    enabled,
    runtimeDeps,
    services,
    onPackageCycle,
    status,
    async stop() {
      stopped = true;
      if (timers.handle) clearInterval(timers.handle);
      await projector?.stop().catch(() => undefined);
      await dispatcher?.stop(5_000).catch(() => undefined);
      // The folder store coalesces runtime-state writes — write the last cursors before the process ends
      await (options.store as { flush?: () => Promise<void> }).flush?.().catch(() => undefined);
      running.length = 0;
    },
  };
}
