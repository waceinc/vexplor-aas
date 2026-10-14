/**
 * Shared integration dependency types — the seam between the work packages (design §13.3, §13.6).
 *
 * Only types live here. WP3 owns this file; the other packages consume it and must not edit it.
 * Anything a package needs beyond these members it defines in its own files; WP3 wires it when the
 * packages are merged. Every runtime member is optional so routes keep working when integrations
 * are disabled (INTEGRATIONS unset, or demo mode) — they then answer with the disabled status.
 */
import type { AssetJoinResolver } from '@aas/core';
import type { AasStore, IntegrationStore } from '@aas/store';

import type { EgressPolicy } from './egress.js';
import type { MasterKeySource, SecretBox, StoreKind } from './secrets.js';

/**
 * The store as the integration code sees it. Once WP1 merges, `AasStore extends IntegrationStore` and this is just
 * `AasStore`; until then it states what the integration code needs.
 */
export type IntegrationAasStore = AasStore & IntegrationStore;

/** What the integration subsystem reports about itself (GET /integrations/status) */
export interface IntegrationStatus {
  enabled: boolean;
  /** Why it is disabled, when it is (a translation key or plain reason) */
  reason?: string;
  /** Subsystems that are running, e.g. 'detector', 'projector', 'dispatcher', 'mqtt' */
  running: string[];
  /** Demo mode forces integrations off */
  demo?: boolean;
  /** Per-worker detail for GET /integrations/status (WP3 fills dispatcher; detector/projector report through boot) */
  workers?: Record<string, Record<string, unknown>>;
}

/** Result of POST /integrations/subscriptions/:id/test */
export type TestDeliveryResult =
  | { ok: true; statusCode?: number; durationMs: number; address: string; responseSnippet: string; serverTime: string }
  | { ok: false; error: string; statusCode?: number; durationMs?: number; address?: string; serverTime: string };

/** OPC UA server certificate trust store (design §7) */
export interface OpcUaPki {
  list(): Promise<{ trusted: OpcUaCertificate[]; rejected: OpcUaCertificate[] }>;
  trust(thumbprint: string): Promise<boolean>;
}

export interface OpcUaCertificate {
  thumbprint: string;
  subject?: string;
  file: string;
}

/** Runtime services the integration routes may call. All optional — see the file header. */
export interface IntegrationRuntimeDeps {
  status(): IntegrationStatus;
  /** Join block resolver shared by detector, projector and exports (WP4 createJoinResolver) */
  join?: AssetJoinResolver & { invalidate(packageId?: string): void };
  /** Tell the dispatcher that new deliveries may be waiting (WP3) */
  wakeDispatcher?(): void;
  /** Tell the detector that a package's integration config changed (WP2) */
  reloadPackageConfig?(packageId: string): void;
  /** Tell the projector to recompute a package now (WP4) */
  flushProjection?(packageId?: string): Promise<void>;
  /** OPC UA certificate store, when the OPC UA server runs (WP2) */
  opcuaPki?(): OpcUaPki | undefined;
  /** Sends `integration.ping.v1` to one subscription right now (WP3 dispatcher) */
  testSubscription?(subscriptionId: string): Promise<TestDeliveryResult | undefined>;
  /** Tell the dispatcher a subscription changed or went away (drops cached MQTT connections) (WP3) */
  subscriptionChanged?(subscriptionId: string): void;
}

/**
 * Server-level integration facts that exist whether or not the workers run (WP3 boot.ts). Subscriptions can be
 * created, listed and rotated with integrations off — only sending needs the workers.
 * Absent in tests that call createApi without booting; the routes then use `defaultIntegrationServices()`.
 */
export interface IntegrationServices {
  /** 12 hex chars, created once and kept in the store (survives restarts) */
  instanceId(): Promise<string>;
  storeKind: StoreKind;
  egress: EgressPolicy;
  /** undefined = no master key (PostgreSQL without AAS_SECRET_KEY) — creating subscriptions answers 503 */
  secrets: SecretBox | undefined;
  masterKey: MasterKeySource;
  now(): number;
  /** Also when the workers are off — says why (`runtime` is absent then) */
  status(): IntegrationStatus;
  /** OPC UA exposure as GET /integrations/status reports it (WP2 refines it at merge) */
  opcua(): { security: 'secure' | 'insecure' | 'off'; pki?: string };
}

/** Every integration route builder has the signature (store, deps) => Route[] */
export interface IntegrationRouteDeps {
  runtime?: IntegrationRuntimeDeps;
  /** WP3 — see IntegrationServices. Other route builders may ignore it */
  services?: IntegrationServices;
  /**
   * Where audit events are written: the base (unscoped) store. In a private workspace the scoped store refuses event
   * writes (server-only log), so an editor's change of their own package config would otherwise leave no audit trail.
   * Absent in tests calling a route builder directly — then the route's own store is used.
   */
  auditStore?: Pick<IntegrationStore, 'appendEvents'>;
  publicBaseUrl?: string;
  collectIntervalMs?: number;
  demo: boolean;
}
