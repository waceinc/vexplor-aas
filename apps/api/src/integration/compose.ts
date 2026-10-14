/**
 * Composition points — where the work of WP2 (runtime, MQTT) and WP4 (join, projector) is plugged into the boot.
 *
 * Why a separate file: WP3 compiles and tests before WP2 and WP4 merge. Everything boot.ts needs from them comes in
 * through these small factory types; this file returns the real factories once the packages are merged.
 *
 * MERGE (WP2 → WP3): `mqttConnect: (options) => MqttPublisher.connect(options)` from `@aas/fieldbus`;
 *   `createDetector: (deps) => new EquipmentDetector(deps)` from `./runtime/detector.js`.
 * MERGE (WP4 → WP3): `createJoin: createJoinResolver` from `./exports/join.js`;
 *   `createProjector: (deps) => new IntegrationProjector(deps)` from `./projector.js`.
 */
import type { AssetJoinResolver } from '@aas/core';
import type { AasStore } from '@aas/store';

import type { Route } from '../router.js';
import type { IntegrationAasStore, IntegrationRouteDeps } from './deps.js';
import type { MqttConnect } from './mqtt-sink.js';

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

/** The factories of the merged packages. Empty until WP2 and WP4 are merged — see the MERGE notes above */
export function integrationComposition(): IntegrationComposition {
  return {};
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

/**
 * The route builders of the merged packages. Empty until merge.
 * MERGE (WP2 → WP3): `equipment: equipmentRoutes` from `./routes-equipment.js`, `opcua: opcuaRoutes` from `./routes-opcua.js`.
 * MERGE (WP4 → WP3): `exports: exportRoutes` from `./routes-exports.js`, `externalRefs: externalRefRoutes` from `./routes-external-refs.js`.
 */
export function integrationRouteBuilders(): IntegrationRouteBuilders {
  return {};
}
