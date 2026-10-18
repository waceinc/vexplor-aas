/**
 * API client — collection — connections (AID) · collected values · standard API export · auto collection · OPC UA serving · virtual PLC
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { AidInterfaceView, AidSecurityChoice, CollectedValueView, LiveMapping, CycleReportView } from './types.js';
import { request } from './http.js';

export const collectionApi = {
  interfaces: (packageId: string): Promise<{ source: string; interfaces: AidInterfaceView[] }> =>
    request(`/packages/${packageId}/interfaces`),
  values: (packageId: string, limit = 200): Promise<{ result: CollectedValueView[] }> =>
    request(`/packages/${packageId}/values?limit=${limit}`),
  /** Time-range values of one tag — used by the daily status bar. from inclusive · to exclusive (ISO), by receive time (so constant-valued tags are caught too) */
  valuesBetween: (
    packageId: string,
    query: { property: string; from: string; to: string; limit?: number },
  ): Promise<{ result: CollectedValueView[] }> =>
    request(
      `/packages/${packageId}/values?property=${encodeURIComponent(query.property)}&from=${encodeURIComponent(query.from)}` +
        `&to=${encodeURIComponent(query.to)}&limit=${query.limit ?? 20000}&basis=received`,
    ),
  /**
   * Which model element each collected value lands on — a connection health check.
   * Unlike the BaSyx DataBridge we do not write back into the model, so **whether the names match** is what matters.
   */
  liveMapping: (
    packageId: string,
  ): Promise<LiveMapping> => request(`/packages/${packageId}/live`),
  /**
   * Create a collection connection (AID) — built per the spec from the endpoint address and the tag list.
   * nameMisses in the response are tags whose names do not match any model element (they cannot be exported live).
   */
  createAid: (
    packageId: string,
    input: {
      endpoint: string;
      title?: string;
      tags: { name: string; href: string; key?: string; type?: string; unit?: string; form?: Record<string, string> }[];
      /** Security the device wants (2.8.0) — OPC UA mode · policy, a login for OPC UA and MQTT. Never a password */
      security?: AidSecurityChoice;
      /** Read period of this connection, ms (2.8.0). Absent: the server's default */
      intervalMs?: number;
      /** Also create slots in OperationalData for tags missing from the model. If absent, nothing is created */
      createMissing?: { group: string; subgroup: string };
    },
  ): Promise<{
    submodelId: string;
    replaced: boolean;
    nameMatches: number;
    nameMisses: string[];
    elementsAdded: string[];
    /** Not created because another submodel has the same name — if created, the value would land nowhere */
    elementsConflicted?: string[];
  }> =>
    request(`/packages/${packageId}/aid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /** Auto-collection status — is it actually running */
  collectStatus: (): Promise<{
    /** Does this server support collection (and the virtual PLC) */
    collect?: boolean;
    running: boolean;
    intervalMs?: number;
    sweeping?: boolean;
    reason?: string;
    lastSweep?: {
      startedAt: string;
      collected: number;
      packages: number;
      results?: { packageId: string; collected: number; errors: string[] }[];
    };
  }> => request('/collect-status'),
  /**
   * Browses the device and fetches its tag list — so nobody has to type NodeIds by hand.
   * If it cannot connect, a 502 with the reason comes back.
   */
  browseDevice: (
    endpoint: string,
    /** The security chosen on the screen (2.8.0) — the server adds the login from its credentials file */
    security?: AidSecurityChoice,
  ): Promise<{
    endpoint: string;
    truncated: boolean;
    nodes: {
      nodeId: string;
      name: string;
      path: string;
      type: 'float' | 'integer' | 'boolean' | 'string';
      value?: string;
      error?: string;
    }[];
  }> =>
    request('/opcua/browse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(security ? { endpoint, security } : { endpoint }),
    }),
  /**
   * OPC UA exposure status (M6·M7) — what we are currently serving to the outside.
   * When off, running:false and the reason come back (this is not an error).
   */
  opcuaStatus: (): Promise<{
    running: boolean;
    endpoint?: string;
    packages: number;
    variables: number;
    lastRefresh?: string;
    lastError?: string;
    reason?: string;
  }> => request('/opcua-status'),
  /** Collect once now. Deployments without a collection adapter return 501 */
  collect: (packageId: string): Promise<CycleReportView> =>
    request(`/packages/${packageId}/collect`, { method: 'POST' }),
  /** Attach this asset to the built-in virtual PLC (simulation) and create a collection connection */
  simulate: (packageId: string): Promise<{ machine: string; endpoint: string; title: string; tags: number }> =>
    request(`/packages/${packageId}/simulate`, { method: 'POST' }),
};
