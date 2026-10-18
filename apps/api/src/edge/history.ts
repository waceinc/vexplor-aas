/**
 * The trend of each remote collector (2.8.0): one point per 5 minutes — the last status in that period and the values
 * stored in it — for the last 24 hours. Kept in the store's runtime state like the rest of the edge state, so the
 * in-memory, folder and PostgreSQL stores all keep it without a schema change.
 *
 * Important: bounded. At most HISTORY_MAX points per collector (about 300 small objects); older points fall off on the
 *    next batch. The screen reads it only when a collector is opened, never with the 10-second device list.
 * Important: written with the activity at most once a minute (state.ts) — a restart may lose the last minute of trend,
 *    as it may lose the last minute of activity. Values are never lost.
 * Important: a point is filed by when its batch was made, not when it arrived. Batches queued during an outage arrive
 *    later in order and land in their own periods, so the trend shows the outage where it happened.
 */
import type { IntegrationStore } from '@aas/store';
import type { EdgeHistoryPoint } from './health.js';

export const HISTORY_STEP_MS = 5 * 60_000;
export const HISTORY_KEEP_MS = 24 * 3_600_000;
const HISTORY_MAX = HISTORY_KEEP_MS / HISTORY_STEP_MS + 1;
const key = (deviceId: string): string => `edge.history.${deviceId}`;

type RuntimeState = Pick<IntegrationStore, 'getRuntimeState' | 'putRuntimeState'>;

const periodOf = (point: EdgeHistoryPoint): number => Math.floor(Date.parse(point.at) / HISTORY_STEP_MS);
/** A point that carries a status (more than `at` and `values`) */
const hasStatus = (point: EdgeHistoryPoint): boolean => Object.keys(point).length > 2;

export class EdgeTrend {
  private readonly loaded = new Map<string, Promise<EdgeHistoryPoint[]>>();
  private readonly dirty = new Set<string>();

  constructor(private readonly store: RuntimeState) {}

  get(deviceId: string): Promise<EdgeHistoryPoint[]> {
    let points = this.loaded.get(deviceId);
    if (!points) {
      points = this.store.getRuntimeState(key(deviceId)).then((saved) => (Array.isArray(saved) ? (saved as EdgeHistoryPoint[]) : []));
      this.loaded.set(deviceId, points);
    }
    return points;
  }

  /** Files a point in its period: values add up, the newest status of the period describes it */
  async add(deviceId: string, point: EdgeHistoryPoint, now: number): Promise<void> {
    const points = await this.get(deviceId);
    const period = periodOf(point);
    const index = points.findIndex((existing) => periodOf(existing) >= period);
    const same = index >= 0 && periodOf(points[index]!) === period ? points[index]! : undefined;
    if (same) {
      const base = hasStatus(point) && (point.at >= same.at || !hasStatus(same)) ? point : same;
      points[index] = { ...base, values: same.values + point.values };
    } else if (index >= 0) points.splice(index, 0, point);
    else points.push(point);
    const from = now - HISTORY_KEEP_MS;
    while (points.length > 0 && (Date.parse(points[0]!.at) < from || points.length > HISTORY_MAX)) points.shift();
    this.dirty.add(deviceId);
  }

  /** Writes the trends that changed since the last write */
  async write(): Promise<void> {
    for (const deviceId of [...this.dirty]) {
      this.dirty.delete(deviceId);
      await this.store.putRuntimeState(key(deviceId), await this.get(deviceId));
    }
  }
}
