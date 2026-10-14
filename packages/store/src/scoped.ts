/**
 * Workspaces — "whose eyes the store is viewed through".
 *
 * Wraps the store in one layer and hands out **only what is visible** to the current request's workspace.
 *
 * Important: **why not just check packageId at the entry point (api.ts)?** Seven routes **list all**
 *    packages — when a bundle looks up equipment bound to a process, when the registry looks up by asset ID,
 *    when another file is attached into the hierarchy. Guarding only the packageId in the URL lets other people's files leak through these paths.
 *    The store is the one place every path goes through, so blocking here leaves no gap even when new routes are added.
 *    (Same reason the audit log's "who" is set in one place — actor.ts)
 *
 * Important: **with no context, everything is visible.** Things that run outside a request — periodic collection, OPC UA exposure,
 *    retention cleanup, template loading — are the server itself and must handle all packages.
 *    A server shared by a team (the default) does not set a context either. So **wrapping with this layer changes
 *    nothing** — it only acts on servers with splitting enabled.
 *
 * There are three rules.
 *   ① Mine              read and edit
 *   ② Ownerless         anyone can **read only** (templates loaded at startup — the source for "import")
 *   ③ Someone else's    appears **as if it does not exist** (404, not 403 — not even its existence is revealed)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { fill, tr } from '@aas/core';

import {
  ForbiddenError,
  NotFoundError,
  type AasStore,
  type CollectedValue,
  type CreateOptions,
  type HistoryRecord,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type ListQuery,
  type NewUser,
  type PackageFileRecord,
  type PackageRecord,
  type PackageScope,
  type PageQuery,
  type PageResult,
  type UserRecord,
  type ValueQuery,
  type WriteOptions,
} from './types.js';
import {
  ExternalRefConflictError,
  type DeliveryRecord,
  type DeliveryResult,
  type DeliveryStats,
  type DeliveryStatus,
  type EventPage,
  type EventQuery,
  type ExternalRefsBatchItem,
  type ExternalRefsDoc,
  type NewEvent,
  type NewSubscription,
  type StoredEvent,
  type SubscriptionPatch,
  type SubscriptionRecord,
  type SubscriptionSecrets,
  type Versioned,
} from './integration-types.js';

export interface Workspace {
  /** Workspace key — becomes the owner of newly uploaded packages */
  key: string;
  /** Sees everything — admins and machines (API keys). Operating requires seeing others' items too */
  seesAll: boolean;
}

const storage = new AsyncLocalStorage<Workspace>();

/** Views the store through `workspace`'s eyes while `fn` runs. If undefined, nothing is set (everything visible) */
export function runInWorkspace<T>(workspace: Workspace | undefined, fn: () => T): T {
  return workspace === undefined ? fn() : storage.run(workspace, fn);
}

export function currentWorkspace(): Workspace | undefined {
  return storage.getStore();
}

/**
 * Whether this package is visible in the current workspace. With no context, everything is visible.
 *
 * Used when handing out **pre-collected data** that bypasses the store (such as the last results of periodic collection) —
 * the layer cannot filter such data, so the place handing it out must ask directly.
 */
export function visibleInWorkspace(record: Pick<PackageRecord, 'owner'> | undefined): boolean {
  const workspace = currentWorkspace();
  if (!workspace) return true;
  if (!record) return false;
  return workspace.seesAll || record.owner === undefined || record.owner === workspace.key;
}

/** Wraps the store in a workspace layer */
export interface ScopeOptions {
  /**
   * Number of files one person (workspace) may own. Unlimited if not given.
   * Important: prevents one person from filling the disk by uploading files endlessly on a public server (2026-10-06 security review).
   *    Not applied to admins/API keys (the see-all side) or to servers that do not split workspaces.
   */
  maxPackagesPerOwner?: number;
}

export function scopeStore(base: AasStore, options: ScopeOptions = {}): AasStore {
  return new ScopedStore(base, options);
}

/**
 * Important: `implements AasStore` is **written out by hand** (not lumped together with a Proxy).
 *    When the store gains a new method, this **fails to compile** — it only passes once someone decides whether that
 *    method may see others' items. Silently passing is the worst outcome.
 */
class ScopedStore implements AasStore {
  constructor(
    private readonly base: AasStore,
    private readonly options: ScopeOptions = {},
  ) {}

  // ── Visible? · Editable? ──────────────────────────────────────────────────

  /** The rule lives in one place, visibleInWorkspace — writing it in two places means only one gets fixed */
  private canRead(record: PackageRecord, _workspace: Workspace): boolean {
    return visibleInWorkspace(record);
  }

  /** Must be readable. Otherwise answer as **nonexistent** */
  private async readable(packageId: string): Promise<void> {
    const workspace = currentWorkspace();
    if (!workspace) return;
    const record = await this.base.getPackage(packageId);
    // Truly missing and someone else's must give **the same answer** — otherwise probing ids would reveal existence
    if (!record || !this.canRead(record, workspace)) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
  }

  /** Must be editable. Others' items are nonexistent; shared items are read-only */
  private async writable(packageId: string): Promise<void> {
    const workspace = currentWorkspace();
    if (!workspace) return;
    const record = await this.base.getPackage(packageId);
    if (!record || !this.canRead(record, workspace)) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
    if (!workspace.seesAll && record.owner !== workspace.key) {
      throw new ForbiddenError(
        tr('함께 쓰는 파일이라 고칠 수 없습니다 — 「다른 파일에서 가져오기」로 내 파일에 가져와 고치십시오.'),
      );
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────
  init(): Promise<void> {
    return this.base.init();
  }

  // ── Packages ──────────────────────────────────────────────────────────────
  async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    const workspace = currentWorkspace();
    // Important: an explicitly given owner wins — "replace wholesale" preserves and passes the original owner (packages.ts).
    //    An admin replacing someone else's file must not make that file the admin's
    //    `null` means "deliberately shared" — keeps a shared file shared after replacing it
    const owner = input.owner === null ? null : (input.owner ?? workspace?.key ?? null);
    // Count only for new files — "replace wholesale" (id given) does not increase the count
    const limit = this.options.maxPackagesPerOwner;
    if (limit !== undefined && workspace && !workspace.seesAll && owner === workspace.key && input.id === undefined) {
      let count = 0;
      let cursor: string | undefined;
      do {
        const page = await this.base.listPackages(cursor === undefined ? { limit: 200 } : { limit: 200, cursor }, { owner: workspace.key });
        count += page.items.filter((item) => item.owner === workspace.key).length;
        cursor = page.cursor;
      } while (cursor !== undefined);
      if (count >= limit) {
        throw new ForbiddenError(fill(tr('파일은 한 사람당 {0}개까지 올릴 수 있습니다 — 안 쓰는 파일을 지우고 다시 하십시오.'), { 0: limit }));
      }
    }
    return this.base.importPackage({ ...input, owner });
  }

  async exportPackage(packageId: string): Promise<AasxPackage> {
    await this.readable(packageId);
    return this.base.exportPackage(packageId);
  }

  async getPackage(packageId: string): Promise<PackageRecord | undefined> {
    const record = await this.base.getPackage(packageId);
    const workspace = currentWorkspace();
    if (!record || !workspace) return record;
    return this.canRead(record, workspace) ? record : undefined;
  }

  listPackages(page?: PageQuery, scope?: PackageScope): Promise<PageResult<PackageRecord>> {
    const workspace = currentWorkspace();
    // With no context or on the see-all side, use the caller's scope as-is (usually none)
    if (!workspace || workspace.seesAll) return this.base.listPackages(page, scope);
    // Important: **ignore** the caller's scope — closes the path for a route to peek by passing someone else's key
    return this.base.listPackages(page, { owner: workspace.key });
  }

  async deletePackage(packageId: string): Promise<void> {
    await this.writable(packageId);
    return this.base.deletePackage(packageId);
  }

  async getEnvironment(packageId: string): Promise<Environment> {
    await this.readable(packageId);
    return this.base.getEnvironment(packageId);
  }

  // ── Non-model parts ───────────────────────────────────────────────────────
  async packageFiles(packageId: string): Promise<PackageFileRecord[]> {
    await this.readable(packageId);
    return this.base.packageFiles(packageId);
  }

  async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    await this.writable(packageId);
    return this.base.putPackageFile(packageId, file);
  }

  async deletePackageFile(packageId: string, part: string): Promise<void> {
    await this.writable(packageId);
    return this.base.deletePackageFile(packageId, part);
  }

  // ── Identifiable ──────────────────────────────────────────────────────────
  async listIdentifiables(
    packageId: string,
    modelType: IdentifiableModelType,
    query?: ListQuery,
  ): Promise<PageResult<IdentifiableRecord>> {
    await this.readable(packageId);
    return this.base.listIdentifiables(packageId, modelType, query);
  }

  async getIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<IdentifiableRecord | undefined> {
    await this.readable(packageId);
    return this.base.getIdentifiable(packageId, modelType, id);
  }

  async createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options?: CreateOptions,
  ): Promise<IdentifiableRecord> {
    await this.writable(packageId);
    return this.base.createIdentifiable(packageId, content, options);
  }

  async updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<IdentifiableRecord> {
    await this.writable(packageId);
    return this.base.updateIdentifiable(packageId, modelType, id, content, options);
  }

  async deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options?: WriteOptions,
  ): Promise<void> {
    await this.writable(packageId);
    return this.base.deleteIdentifiable(packageId, modelType, id, options);
  }

  // ── Collected values ──────────────────────────────────────────────────────
  async appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void> {
    await this.writable(packageId);
    return this.base.appendValues(packageId, values);
  }

  async readValues(packageId: string, query?: ValueQuery): Promise<CollectedValue[]> {
    await this.readable(packageId);
    return this.base.readValues(packageId, query);
  }

  /**
   * Retention cleanup — deletes old values from **all packages**.
   * Important: cannot be called within a workspace. One visitor's request must not delete others' collected values.
   *    (Currently only the server itself calls it — outside any request context)
   */
  pruneValues(before: string): Promise<number> {
    const workspace = currentWorkspace();
    if (workspace && !workspace.seesAll) {
      throw new ForbiddenError(tr('수집값 정리는 서버만 할 수 있습니다.'));
    }
    return this.base.pruneValues(before);
  }

  async history(packageId: string, modelType: IdentifiableModelType, id: string): Promise<HistoryRecord[]> {
    await this.readable(packageId);
    return this.base.history(packageId, modelType, id);
  }

  // ── Integration (docs/design/integration-v1.md §3.6) ─────────────────────
  // Important: decided method by method. Subscriptions, deliveries and runtime state are server-wide (D18) — a workspace
  //    visitor must not even list them (a webhook URL tells where the plant's MES lives). Events are filtered to
  //    own + shared rows; per-package config and refs follow the package's read/write rules.

  /** Server-only operations — refused inside a workspace that does not see everything (same rule as pruneValues) */
  private serverOnly(): void {
    const workspace = currentWorkspace();
    if (workspace && !workspace.seesAll) throw new ForbiddenError(tr('연동 구독·전달·이벤트 기록은 서버 관리 쪽에서만 다룰 수 있습니다.'));
  }

  /** Keeps only rows of packages visible in the current workspace */
  private async visibleRows<T extends { packageId: string }>(rows: T[]): Promise<T[]> {
    const workspace = currentWorkspace();
    if (!workspace || workspace.seesAll) return rows;
    const kept: T[] = [];
    for (const row of rows) if (visibleInWorkspace(await this.base.getPackage(row.packageId))) kept.push(row);
    return kept;
  }

  readEvents(query: EventQuery, scope?: PackageScope): Promise<EventPage> {
    const workspace = currentWorkspace();
    if (!workspace || workspace.seesAll) return this.base.readEvents(query, scope);
    // Important: the caller's scope and includeAudit are **ignored** — audit rows are admin-only (D11) and a route
    //    must not be able to read another workspace by passing its key
    return this.base.readEvents({ ...query, includeAudit: false }, { owner: workspace.key });
  }
  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    this.serverOnly();
    return this.base.appendEvents(events);
  }
  pruneEvents(before: string): Promise<number> {
    this.serverOnly();
    return this.base.pruneEvents(before);
  }

  listSubscriptions(): Promise<SubscriptionRecord[]> {
    this.serverOnly();
    return this.base.listSubscriptions();
  }
  getSubscription(id: string): Promise<(SubscriptionRecord & { secrets: SubscriptionSecrets }) | undefined> {
    this.serverOnly();
    return this.base.getSubscription(id);
  }
  createSubscription(input: NewSubscription): Promise<SubscriptionRecord> {
    this.serverOnly();
    return this.base.createSubscription(input);
  }
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined> {
    this.serverOnly();
    return this.base.updateSubscription(id, patch);
  }
  deleteSubscription(id: string): Promise<boolean> {
    this.serverOnly();
    return this.base.deleteSubscription(id);
  }

  enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number> {
    this.serverOnly();
    return this.base.enqueueDeliveries(rows, now);
  }
  claimDeliveries(now: string, limit: number, leaseMs: number, subscriptionId?: string): Promise<DeliveryRecord[]> {
    this.serverOnly();
    return this.base.claimDeliveries(now, limit, leaseMs, subscriptionId);
  }
  completeDelivery(id: string, result: DeliveryResult): Promise<boolean> {
    this.serverOnly();
    return this.base.completeDelivery(id, result);
  }
  getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    this.serverOnly();
    return this.base.getDelivery(id);
  }
  listDeliveries(subscriptionId: string, query?: { status?: DeliveryStatus } & PageQuery): Promise<PageResult<DeliveryRecord>> {
    this.serverOnly();
    return this.base.listDeliveries(subscriptionId, query);
  }
  extendLease(id: string, attempt: number, leaseUntil: string): Promise<boolean> {
    this.serverOnly();
    return this.base.extendLease(id, attempt, leaseUntil);
  }
  redeliver(id: string, now: string): Promise<boolean> {
    this.serverOnly();
    return this.base.redeliver(id, now);
  }
  deliveryStats(): Promise<DeliveryStats[]> {
    this.serverOnly();
    return this.base.deliveryStats();
  }
  pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number> {
    this.serverOnly();
    return this.base.pruneDeliveries(succeededBefore, deadBefore);
  }

  /** Read by everyone — the state rules and calendar drive what every workspace's screens show */
  getServerIntegrationConfig(): Promise<Versioned<unknown> | undefined> {
    return this.base.getServerIntegrationConfig();
  }
  putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    this.serverOnly();
    return this.base.putServerIntegrationConfig(value, expectedRevision);
  }
  async getPackageIntegrationConfig(packageId: string): Promise<Versioned<unknown> | undefined> {
    await this.readable(packageId);
    return this.base.getPackageIntegrationConfig(packageId);
  }
  async putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    await this.writable(packageId);
    return this.base.putPackageIntegrationConfig(packageId, value, expectedRevision);
  }

  async getExternalRefs(packageId: string): Promise<Versioned<ExternalRefsDoc> | undefined> {
    await this.readable(packageId);
    return this.base.getExternalRefs(packageId);
  }
  /**
   * Important: uniqueness is server-wide, so a conflict can name a package of another workspace. That claim's package
   *    and subject (which carries its globalAssetId) are masked — the visitor learns the number is taken, not by what.
   */
  async putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>> {
    await this.writable(packageId);
    try {
      return await this.base.putExternalRefs(packageId, doc, expectedRevision);
    } catch (error) {
      throw await this.maskConflict(error);
    }
  }
  async putExternalRefsBatch(items: readonly ExternalRefsBatchItem[]): Promise<Versioned<ExternalRefsDoc>[]> {
    // Every package must be writable before anything is written — the batch is all-or-nothing
    for (const item of items) await this.writable(item.packageId);
    try {
      return await this.base.putExternalRefsBatch(items);
    } catch (error) {
      throw await this.maskConflict(error);
    }
  }
  /**
   * Every holder, from the server-wide claim table — a dry run inside a workspace must see that a key is already taken
   * in another workspace, or it promises an import that the write then refuses. Holders the workspace cannot see are
   * masked like conflict claims: the visitor learns the key is taken, not where.
   */
  async findExternalRef(system: string, type: string, id: string): Promise<{ packageId: string; subject: string }[]> {
    const holders = await this.base.findExternalRef(system, type, id);
    return Promise.all(holders.map((holder) => this.maskHolder(holder)));
  }

  /** A holder in a package the current workspace cannot see — package and subject (it carries the asset id) hidden */
  private async maskHolder<T extends { packageId: string; subject: string }>(holder: T): Promise<T> {
    const workspace = currentWorkspace();
    if (!workspace || workspace.seesAll || visibleInWorkspace(await this.base.getPackage(holder.packageId))) return holder;
    return { ...holder, packageId: tr('다른 작업 공간의 파일'), subject: '' };
  }

  private async maskConflict(error: unknown): Promise<unknown> {
    if (!(error instanceof ExternalRefConflictError)) return error;
    const workspace = currentWorkspace();
    if (!workspace || workspace.seesAll) return error;
    return new ExternalRefConflictError(await Promise.all(error.claims.map((claim) => this.maskHolder(claim))));
  }
  async listExternalRefs(): Promise<{ packageId: string; refs: Versioned<ExternalRefsDoc> }[]> {
    return this.visibleRows(await this.base.listExternalRefs());
  }

  getRuntimeState(key: string): Promise<unknown | undefined> {
    this.serverOnly();
    return this.base.getRuntimeState(key);
  }
  putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> {
    this.serverOnly();
    return this.base.putRuntimeState(key, value, packageId);
  }

  // ── Users — independent of workspaces. Who may manage accounts is decided by the routes (roles) ──
  findUserByLogin(login: string): Promise<UserRecord | undefined> {
    return this.base.findUserByLogin(login);
  }
  getUser(id: string): Promise<UserRecord | undefined> {
    return this.base.getUser(id);
  }
  listUsers(): Promise<UserRecord[]> {
    return this.base.listUsers();
  }
  createUser(user: NewUser): Promise<UserRecord> {
    return this.base.createUser(user);
  }
  updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email'>>,
  ): Promise<UserRecord | undefined> {
    return this.base.updateUser(id, patch);
  }
  deleteUser(id: string): Promise<boolean> {
    return this.base.deleteUser(id);
  }
  touchUserLogin(id: string): Promise<void> {
    return this.base.touchUserLogin(id);
  }
  countUsers(): Promise<number> {
    return this.base.countUsers();
  }
}
