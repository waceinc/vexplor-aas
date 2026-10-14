/**
 * Shared integration dependency types — the seam between the work packages (design §13.3, §13.6).
 *
 * Only types live here. WP3 owns this file; the other packages consume it and must not edit it.
 * Anything a package needs beyond these members it defines in its own files; WP3 wires it when the
 * packages are merged. Every runtime member is optional so routes keep working when integrations
 * are disabled (INTEGRATIONS unset, or demo mode) — they then answer with the disabled status.
 */
import type { AssetJoinResolver } from '@aas/core';

/** What the integration subsystem reports about itself (GET /integrations/status) */
export interface IntegrationStatus {
  enabled: boolean;
  /** Why it is disabled, when it is (a translation key or plain reason) */
  reason?: string;
  /** Subsystems that are running, e.g. 'detector', 'projector', 'dispatcher', 'mqtt' */
  running: string[];
}

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
}

/** Every integration route builder has the signature (store, deps) => Route[] */
export interface IntegrationRouteDeps {
  runtime?: IntegrationRuntimeDeps;
  publicBaseUrl?: string;
  collectIntervalMs?: number;
  demo: boolean;
}
