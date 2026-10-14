/**
 * Connection health per AID interface (docs/design/integration-v1.md §6.3).
 *
 * `lost` after `lostAfterFailures` consecutive cycles in which the interface itself failed (connect or read call threw);
 * `restored` on the first successful cycle after `lost`. Bad tags alone never mean lost — a dead sensor on a live PLC is
 * a quality problem, not a connection problem, and reporting it as lost would send the maintenance crew to the network.
 */
import type { AidInterface } from '@aas/collector';
import { EVENT_TYPES, type AssetJoin, type CollectionConnectionData, type PackageIntegrationConfig } from '@aas/core';
import type { PackageCycle } from '../../supervisor.js';
import { maskCredentials } from '../ids.js';
import type { DetectorState } from './detector-state.js';
import { keepOnly } from './detector-state.js';
export interface ConnectionTrack {
  failures: number;
  lost: boolean;
  /** First failure of the current streak */
  since?: string;
  lastError?: string;
}

export interface ConnectionCycle {
  track: ConnectionTrack;
  lost?: { since: string; consecutiveFailures: number; error: string | null };
  restored?: { since: string; consecutiveFailures: number };
}

/**
 * @param error the interface error of this cycle, undefined when it was read
 * @param at cycle start time (ISO) — deterministic for a re-processed cycle
 */
export function stepConnection(track: ConnectionTrack, error: string | undefined, at: string, lostAfterFailures: number): ConnectionCycle {
  if (error !== undefined) {
    const since = track.failures > 0 && track.since !== undefined ? track.since : at;
    const failures = track.failures + 1;
    const next: ConnectionTrack = { failures, lost: track.lost, since, lastError: error };
    if (!track.lost && failures >= lostAfterFailures) {
      next.lost = true;
      return { track: next, lost: { since, consecutiveFailures: failures, error } };
    }
    return { track: next };
  }
  if (track.lost) return { track: { failures: 0, lost: false }, restored: { since: at, consecutiveFailures: track.failures } };
  return { track: { failures: 0, lost: false } };
}

/** Connection events of one cycle — also for packages without an integration config */
export function detectConnections(
  config: PackageIntegrationConfig | null,
  state: DetectorState,
  cycle: PackageCycle,
  asset: AssetJoin,
  isSimulated: (iface: AidInterface) => boolean,
  push: (type: string, key: string, time: string, value: unknown, data: Record<string, unknown>) => void,
): void {
  const lostAfter = config?.connection.lostAfterFailures ?? 2;
  const at = cycle.cycle.startedAt;
  state.connections = keepOnly(state.connections, cycle.interfaces.map((iface) => iface.name));
  for (const iface of cycle.interfaces) {
    const entry = cycle.cycle.interfaces.find((candidate) => candidate.name === iface.name);
    if (!entry) continue; // not attempted in this cycle (an overlapping run was skipped)
    const result = stepConnection(state.connections[iface.name] ?? { failures: 0, lost: false }, entry.error, at, lostAfter);
    state.connections[iface.name] = result.track;
    const base = { asset, interfaceName: iface.name, protocol: iface.protocol, endpoint: maskCredentials(iface.base ?? ''), simulated: isSimulated(iface) };
    if (result.lost) {
      const data: CollectionConnectionData = { ...base, error: result.lost.error, since: result.lost.since, consecutiveFailures: result.lost.consecutiveFailures };
      push(EVENT_TYPES.collectionConnectionLost, iface.name, result.lost.since, 'lost', data);
    }
    if (result.restored) {
      const data: CollectionConnectionData = { ...base, error: null, since: result.restored.since, consecutiveFailures: result.restored.consecutiveFailures };
      push(EVENT_TYPES.collectionConnectionRestored, iface.name, result.restored.since, 'restored', data);
    }
  }
}
