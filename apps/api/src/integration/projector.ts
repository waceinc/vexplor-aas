/**
 * Projection events — `equipment.master|bom|maintenance|documents.changed` (design §2.3, ERP §6, E-19…E-22).
 *
 * The projector follows the model events in the log, waits until a package has been quiet for the debounce (5 s — the
 * editor saves per keystroke batch and an ERP should not get 30 events for typing a serial number), recomputes the
 * four projections and compares their digests with the last ones. Only a real difference becomes an event, so a live
 * value or a thumbnail change produces nothing. Events are state notifications: receivers re-read `href`.
 *
 * Crash safety: event ids are deterministic (`eventIdFor` over type, subject, key, the triggering model event time and
 * the projection hash) and the persisted cursor never passes a package that is still waiting, so a restart re-projects
 * and the store skips what was already appended.
 *
 * Digest state lives in runtime state `projector:<packageId>` **without** the package link on purpose: deleting a
 * package deletes its linked rows, and the projector still needs the last digest to announce `operation: "removed"`.
 */
import { EVENT_TYPES, type AssetJoin, type AssetJoinResolver, type EquipmentMasterChangedData, type EquipmentProjectionChangedData, type ProjectionOperation } from '@aas/core';
import type { AasStore, NewEvent, StoredEvent } from '@aas/store';
import type { TimerHost } from '@aas/collector';
import { eventIdFor, settledPrefix } from './ids.js';
import { buildAssetDirectory, type AssetDirectoryEntry } from './exports/hierarchy.js';
import { createJoinResolver, loadLocationIndex } from './exports/join.js';
import type { LocationEntry } from './exports/location.js';
import { allPackages, integrationStore, type IntegrationAasStore } from './exports/store.js';
import { computeState, PART_TYPES, type Part, type ProjectorState } from './projector-state.js';

export { masterValues, type ProjectorState } from './projector-state.js';

export const PROJECTOR_CURSOR_KEY = 'projector:cursor';
export const PROJECTOR_DEBOUNCE_MS = 5_000;
/** A package edited without pause is still projected after this long */
const MAX_WAIT_MS = 30_000;

export interface ProjectorOptions {
  store: AasStore;
  join?: AssetJoinResolver & { invalidate(packageId?: string): void };
  publicBaseUrl?: string;
  debounceMs?: number;
  pollMs?: number;
  /** Epoch ms */
  now?: () => number;
  timers?: TimerHost;
}

interface Dirty {
  firstSeq: number;
  occurredAt: string;
  due: number;
  deadline: number;
}

const stateKey = (packageId: string): string => `projector:${packageId}`;

export class IntegrationProjector {
  private readonly store: IntegrationAasStore;
  private readonly join: AssetJoinResolver & { invalidate(packageId?: string): void };
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly timers: TimerHost;
  private readonly dirty = new Map<string, Dirty>();
  private readCursor: number | undefined;
  private timer: unknown;
  private running: Promise<unknown> | undefined;
  /**
   * Every entry point (timer pass, route-triggered flushNow) runs through this chain, one at a time. Two passes side by
   * side shared the dirty map and the cursor: one deleted a package another had just re-marked, and saved the cursor
   * past that newer event — the edit was lost for good (review M2).
   */
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = true;
  lastRunAt: string | undefined;

  constructor(private readonly options: ProjectorOptions) {
    this.store = integrationStore(options.store);
    this.join = options.join ?? createJoinResolver(options.store, options.publicBaseUrl);
    this.debounceMs = options.debounceMs ?? PROJECTOR_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? (globalThis as unknown as TimerHost);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.running = this.runOnce()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, this.pollMs);
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** One loop pass: read new model events, project the packages whose debounce ran out */
  runOnce(): Promise<StoredEvent[]> {
    return this.exclusive(() => this.pass());
  }

  private async pass(): Promise<StoredEvent[]> {
    await this.poll();
    const now = this.now();
    const due = [...this.dirty].filter(([, entry]) => entry.due <= now || entry.deadline <= now).map(([id]) => id);
    return this.flushPackages(due);
  }

  /** Project now, without waiting for the debounce — all waiting packages, or one package even if nothing changed in the log */
  flushNow(packageId?: string): Promise<StoredEvent[]> {
    return this.exclusive(() => this.flush(packageId));
  }

  private async flush(packageId?: string): Promise<StoredEvent[]> {
    await this.poll();
    if (packageId === undefined) return this.flushPackages([...this.dirty.keys()]);
    // Called after a change outside the model (external refs) — the cached join block is stale too
    this.join.invalidate(packageId);
    if (!this.dirty.has(packageId)) {
      this.dirty.set(packageId, { firstSeq: Number.MAX_SAFE_INTEGER, occurredAt: await this.lastChangeAt(packageId), due: 0, deadline: 0 });
    }
    return this.flushPackages([packageId]);
  }

  /**
   * When a package last changed — the time a flush without a triggering event uses. It must come from stored data, not
   * the clock: a retry after a crash then derives the same event ids and the store skips them (review M3).
   */
  private async lastChangeAt(packageId: string): Promise<string> {
    const times = [(await this.store.getPackage(packageId))?.updatedAt, (await this.store.getExternalRefs(packageId))?.updatedAt]
      .filter((time): time is string => typeof time === 'string')
      .sort();
    return times[times.length - 1] ?? new Date(0).toISOString();
  }

  private async poll(): Promise<void> {
    let cursor = this.readCursor ?? (await this.initialCursor());
    this.readCursor = cursor;
    const now = this.now();
    for (;;) {
      // Audit rows are included so the batch has no holes that settledPrefix would wait on
      const page = await this.store.readEvents({ after: cursor, limit: 500, includeAudit: true });
      const settled: StoredEvent[] = settledPrefix(page.items, cursor, now);
      for (const event of settled) {
        // Every model.* event marks its package — including `model.externalrefs.updated`, so a refs change reaches the
        // projection from the log even if the route's flushNow never ran (crash, projector off; review M3)
        if (!event.type.startsWith('kr.vexplor.aas.model.') || event.packageId === undefined) continue;
        const known = this.dirty.get(event.packageId);
        this.dirty.set(event.packageId, {
          firstSeq: Math.min(known?.firstSeq ?? event.seq, event.seq),
          occurredAt: known && known.occurredAt > event.time ? known.occurredAt : event.time,
          due: now + this.debounceMs,
          deadline: known?.deadline ?? now + MAX_WAIT_MS,
        });
        this.join.invalidate(event.packageId);
      }
      if (settled.length > 0) cursor = settled[settled.length - 1]!.seq;
      this.readCursor = cursor;
      if (settled.length < page.items.length || page.items.length < 500) break;
    }
    await this.saveCursor();
  }

  /** First run: record the current digests of every package silently and start after the newest event */
  private async initialCursor(): Promise<number> {
    const saved = (await this.store.getRuntimeState(PROJECTOR_CURSOR_KEY)) as { seq?: number } | undefined;
    if (typeof saved?.seq === 'number') return saved.seq;
    const lastSeq = (await this.store.readEvents({ after: 0, limit: 1, includeAudit: true })).lastSeq;
    const locations = await loadLocationIndex(this.store);
    for (const record of await allPackages(this.store)) {
      const { state } = await this.project(record.id, locations, new Date(this.now()).toISOString());
      if (state) await this.store.putRuntimeState(stateKey(record.id), state);
    }
    await this.store.putRuntimeState(PROJECTOR_CURSOR_KEY, { seq: lastSeq });
    return lastSeq;
  }

  /** The persisted cursor never passes a package that is still waiting to be projected */
  private async saveCursor(): Promise<void> {
    if (this.readCursor === undefined) return;
    const waiting = Math.min(...[...this.dirty.values()].map((entry) => entry.firstSeq - 1), this.readCursor);
    await this.store.putRuntimeState(PROJECTOR_CURSOR_KEY, { seq: waiting });
  }

  private async flushPackages(packageIds: readonly string[]): Promise<StoredEvent[]> {
    if (packageIds.length === 0) return [];
    const appended: StoredEvent[] = [];
    const locations = await loadLocationIndex(this.store);
    let directory: Map<string, AssetDirectoryEntry[]> | undefined;
    const queue: [string, string][] = [];
    for (const packageId of packageIds) {
      const entry = this.dirty.get(packageId);
      if (entry) queue.push([packageId, entry.occurredAt]);
    }
    const done = new Set<string>();
    while (queue.length > 0) {
      const [packageId, occurredAt] = queue.shift()!;
      if (done.has(packageId)) continue;
      done.add(packageId);
      // Only the entry seen now may be cleared — a newer change re-marks the package with a new object
      const taken = this.dirty.get(packageId);
      const { events, state, placed } = await this.project(packageId, locations, occurredAt);
      if (events.length > 0) appended.push(...(await this.store.appendEvents(events)));
      // The digest is written after the events: a crash in between re-projects and the ids dedupe.
      // A removed package leaves no row behind — written only after its removal events are in the log (review L8)
      await this.store.putRuntimeState(stateKey(packageId), state);
      if (this.dirty.get(packageId) === taken) this.dirty.delete(packageId);
      // A company / process file moved, added or removed equipment: their location (path, ISA-95) changed with it
      if (placed.length > 0) {
        directory ??= await buildAssetDirectory(this.store);
        for (const globalAssetId of placed) {
          for (const holder of directory.get(globalAssetId) ?? []) if (!done.has(holder.packageId)) queue.push([holder.packageId, occurredAt]);
        }
      }
    }
    this.lastRunAt = new Date(this.now()).toISOString();
    await this.saveCursor();
    return appended;
  }

  private href(kind: string, packageId: string): string {
    const base = (this.options.publicBaseUrl ?? '').replace(/\/+$/, '');
    return `${base}/integrations/exports/${kind}?format=json&packageId=${encodeURIComponent(packageId)}`;
  }

  /** New state of a package and the events that lead there from the stored state */
  private async project(
    packageId: string,
    locations: Map<string, LocationEntry[]>,
    occurredAt: string,
  ): Promise<{ events: NewEvent[]; state: ProjectorState | undefined; placed: string[] }> {
    const previous = ((await this.store.getRuntimeState(stateKey(packageId))) ?? undefined) as ProjectorState | undefined;
    const record = await this.store.getPackage(packageId);
    const state = record
      ? { ...(await computeState(this.store, (await this.join(packageId))!, packageId, locations)), owner: record.owner ?? null }
      : undefined;
    // Explicit owner on every event: the package's, or for a deleted one the owner kept in the digest. Without either the
    // store files the row as admin-only (ORPHAN_OWNER) — never visible to another workspace (review H1)
    const owner = record ? (record.owner ?? null) : previous?.owner;
    const events: NewEvent[] = [];
    const revision = record?.revision ?? 0;
    const event = (type: string, key: string, asset: AssetJoin, operation: ProjectionOperation, hash: string, data: EquipmentProjectionChangedData | EquipmentMasterChangedData): void => {
      const subject = asset.globalAssetId ?? packageId;
      events.push({
        id: eventIdFor(type, subject, key, occurredAt, { operation, hash }),
        type,
        time: occurredAt,
        packageId,
        ...(asset.globalAssetId ? { subject: asset.globalAssetId } : {}),
        ...(record ? { packageRevision: revision } : {}),
        ...(owner !== undefined ? { owner } : {}),
        data,
      });
    };

    const master = state?.master ?? {};
    for (const key of [...new Set([...Object.keys(previous?.master ?? {}), ...Object.keys(master)])].sort()) {
      const before = previous?.master[key];
      const after = master[key];
      if (before && after && before.hash === after.hash) continue;
      const operation: ProjectionOperation = !before ? 'created' : !after ? 'removed' : 'updated';
      const columns = Object.keys({ ...before?.values, ...after?.values });
      const changedKeys = columns.filter((column) => (before?.values[column] ?? '') !== (after?.values[column] ?? '')).sort();
      const digest = (after ?? before)!;
      event(EVENT_TYPES.equipmentMasterChanged, `master|${key}`, digest.asset, operation, after?.hash ?? 'removed', {
        asset: digest.asset,
        operation,
        changedKeys,
        revision,
        projectionHash: after?.hash ?? before!.hash,
        href: this.href('equipment', packageId),
      });
    }
    for (const part of Object.keys(PART_TYPES) as Part[]) {
      const before = previous?.parts[part];
      const after = state?.parts[part];
      if ((!before && !after) || (before && after && before.hash === after.hash)) continue;
      const operation: ProjectionOperation = !before ? 'created' : !after ? 'removed' : 'updated';
      const digest = (after ?? before)!;
      event(PART_TYPES[part], part, digest.asset, operation, after?.hash ?? 'removed', {
        asset: digest.asset,
        operation,
        revision,
        projectionHash: digest.hash,
        href: this.href(part, packageId),
      });
    }
    const placed = [...new Set([...(previous?.placed ?? []), ...(state?.placed ?? [])])];
    return { events, state, placed };
  }
}
