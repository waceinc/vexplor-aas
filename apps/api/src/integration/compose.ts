/**
 * Composition — where the work of WP2 (runtime, MQTT, equipment and OPC UA routes) and WP4 (join, projector, export
 * and external-reference routes) is plugged into the boot and the route table.
 *
 * boot.ts and routes.ts depend only on the small factory types below; this file supplies the real factories. Tests
 * pass their own (fakes, empty builders) instead.
 */
import type { AssetJoinResolver } from '@aas/core';
import type { AasStore } from '@aas/store';

import type { Route } from '../router.js';
import type { IntegrationAasStore, IntegrationRouteDeps } from './deps.js';
import { createJoinResolver } from './exports/join.js';
import type { MqttConnect } from './mqtt-sink.js';
import { IntegrationProjector } from './projector.js';
import { readServerConfig } from './route-support.js';
import { equipmentRoutes } from './routes-equipment.js';
import { exportRoutes } from './routes-exports.js';
import { externalRefRoutes } from './routes-external-refs.js';
import { opcuaRoutes } from './routes-opcua.js';
import { EquipmentDetector } from './runtime/detector.js';

export type JoinWithInvalidate = AssetJoinResolver & { invalidate(packageId?: string): void };

/** The part of WP4's IntegrationProjector the boot drives */
export interface ProjectorLike {
  start(): void;
  stop(): Promise<void>;
  flushNow(packageId?: string): Promise<void>;
  status?(): Record<string, unknown>;
}

/** The part of WP2's EquipmentDetector the boot drives. `cycle` is WP2's PackageCycle */
export interface DetectorLike {
  onPackageCycle(cycle: never): Promise<unknown>;
  reloadPackageConfig?(packageId: string): void;
  status?(): Record<string, unknown>;
}

export interface IntegrationComposition {
  mqttConnect?: MqttConnect;
  createJoin?: (store: IntegrationAasStore, publicBaseUrl?: string) => JoinWithInvalidate;
  createProjector?: (deps: { store: IntegrationAasStore; join: JoinWithInvalidate; publicBaseUrl?: string; now?: () => number }) => ProjectorLike;
  createDetector?: (deps: { store: IntegrationAasStore; join: JoinWithInvalidate; collectIntervalMs?: number }) => DetectorLike;
}

/** The real factories. One join resolver is created by the boot and shared by projector, detector and routes */
export function integrationComposition(): IntegrationComposition {
  return {
    // @aas/fieldbus is loaded on first use, like the collector adapters in server.ts
    mqttConnect: async (options) => (await import('@aas/fieldbus')).MqttPublisher.connect(options),
    createJoin: (store, publicBaseUrl) => createJoinResolver(store, publicBaseUrl),
    createProjector: ({ store, join, publicBaseUrl, now }) => {
      const projector = new IntegrationProjector({ store, join, ...(publicBaseUrl ? { publicBaseUrl } : {}), ...(now ? { now } : {}) });
      return {
        start: () => projector.start(),
        stop: () => projector.stop(),
        flushNow: async (packageId?: string) => void (await projector.flushNow(packageId)),
        status: () => ({ running: true, ...(projector.lastRunAt ? { lastRunAt: projector.lastRunAt } : {}) }),
      };
    },
    createDetector: ({ store, join }) => {
      const detector = new EquipmentDetector({ store, join, serverConfig: async () => (await readServerConfig(store)).value });
      return {
        onPackageCycle: (cycle: never) => detector.onPackageCycle(cycle),
        status: () => ({ enabled: true, ...(detector.lastCycleAt ? { lastCycleAt: detector.lastCycleAt } : {}) }),
      };
    },
  };
}

/** A route builder of the merged packages — the agreed signature (§13.3) */
export type IntegrationRouteBuilder = (store: AasStore, deps: IntegrationRouteDeps) => Route[];

export interface IntegrationRouteBuilders {
  /** WP2 `equipmentRoutes` (config, segments, OEE inputs, meters) */
  equipment?: IntegrationRouteBuilder;
  /** WP2 `opcuaRoutes` (certificates) */
  opcua?: IntegrationRouteBuilder;
  /** WP4 `exportRoutes` (exports, readiness) */
  exports?: IntegrationRouteBuilder;
  /** WP4 `externalRefRoutes` */
  externalRefs?: IntegrationRouteBuilder;
}

/** The route builders of WP2 and WP4 */
export function integrationRouteBuilders(): IntegrationRouteBuilders {
  return { equipment: equipmentRoutes, opcua: opcuaRoutes, exports: exportRoutes, externalRefs: externalRefRoutes };
}
