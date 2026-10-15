/**
 * Folder store — keeps files in a folder on your own computer.
 *
 * There is exactly one reason it exists: **to get rid of Docker.**
 * Until now there were only two stores — memory (gone when stopped) and PostgreSQL (needs Docker).
 * Telling a solo user "start a database if you want your files to persist" is too much.
 * This is where the complaint that installation is hard actually came from (2026-08-25, a user).
 *
 * The design is simple: **reuse InMemoryStore as-is and write to the folder on every change.**
 * Since no new data structures are written, there is no room for the two stores' behavior to diverge —
 * the same conformance tests (test/conformance.ts) run unchanged.
 *
 * Folder layout:
 *
 *   <data folder>/
 *     pkg_1/model.json      package, elements, attachments, history (rewritten whole on every change)
 *     pkg_1/values.jsonl    collected values (appended one per line)
 *     users.json            accounts (passwords as hashes only) — rewritten whole on every change
 *     events.jsonl · deliveries.jsonl · integration.json · integration-state.json
 *                           integration (events, subscriptions, deliveries, configs, refs, state) — folder-integration.ts
 *
 * Important: accounts were once left out (2026-10-06, measured by a user). Only packages were written and accounts stayed in memory,
 *    so after creating an admin and restarting the server, the accounts vanished and it went back to "create the first admin".
 *    In the meantime the server sits empty **without even being in protected mode**, so it was also a security issue.
 *
 * Important: why collected values are not put into model.json: collection runs every few seconds.
 *    Rewriting a multi-MB file including attachments each time grinds the disk. So they were split into appends.
 */
import { mkdir, readFile, readdir, rename as fsRename, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fill, tr } from '@aas/core';
import type { AasxPackage } from '@aas/aasx';
import { InMemoryStore, type PackageSnapshot, type UserSnapshot } from './memory.js';
import { FolderIntegrationFiles, type RenameFn } from './folder-integration.js';
import type {
  DeliveryRecord,
  DeliveryResult,
  ExternalRefsBatchItem,
  ExternalRefsDoc,
  NewEvent,
  NewSubscription,
  StoredEvent,
  SubscriptionPatch,
  SubscriptionRecord,
  Versioned,
} from './integration-types.js';
import type {
  CollectedValue,
  IdentifiableModelType,
  IdentifiableRecord,
  PackageFileRecord,
  PackageRecord,
  NewUser,
  UserRecord,
  WriteOptions, CreateOptions } from './types.js';
import { InvalidPackageIdError } from './types.js';

const MODEL_FILE = 'model.json';
const USERS_FILE = 'users.json';
const VALUES_FILE = 'values.jsonl';

/**
 * Shape of a package id that may become a folder name — generated ids are `pkg_N`.
 * Important: the id is used as a path. Without this check an id like `../x` writes outside the data folder and
 *    `deletePackage` removes a folder of the attacker's choosing (red-team M3, 2026-10-16). Every method that builds
 *    a path goes through packageDir; nothing joins a package id by hand.
 */
const PACKAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Test seams — a failing rename is how a torn write (power loss between two files) is reproduced */
export interface FolderStoreOptions {
  rename?: RenameFn;
}

export class FolderStore extends InMemoryStore {
  private readonly rename: RenameFn;
  private readonly files: FolderIntegrationFiles;

  constructor(
    private readonly dir: string,
    now: () => string = () => new Date().toISOString(),
    options: FolderStoreOptions = {},
  ) {
    super(now);
    this.rename = options.rename ?? fsRename;
    this.files = new FolderIntegrationFiles(dir, this.integration, this.rename, () => this.packageIds(), now);
  }

  /** Loads the folder. Creates it if it does not exist */
  override async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.readUsers();
    const entries = await readdir(this.dir, { withFileTypes: true });
    for (const entry of entries) {
      // Folders that are not package ids are not ours (someone's backup, a stray copy) — leave them alone
      if (!entry.isDirectory() || !PACKAGE_ID.test(entry.name)) continue;
      const modelPath = join(this.packageDir(entry.name), MODEL_FILE);
      let snapshot: PackageSnapshot;
      try {
        snapshot = JSON.parse(await readFile(modelPath, 'utf8')) as PackageSnapshot;
      } catch {
        // Important: one broken package must not prevent opening the rest. Skip just that one.
        //    (Not deleted either — the user must be able to look at it and decide)
        continue;
      }
      this.restore(snapshot, await this.readValueFile(entry.name));
    }
    // After the packages: voiding an event needs the revision that actually reached disk
    const revisions = new Map<string, number>();
    for (const packageId of this.packageIds()) revisions.set(packageId, (await this.getPackage(packageId))!.revision);
    await this.files.load((packageId) => revisions.get(packageId));
  }

  /** Writes the coalesced runtime-state file now — for shutdown and tests (every other write is already on disk) */
  async flush(): Promise<void> {
    await this.files.flushState();
  }

  private async readUsers(): Promise<void> {
    let text: string;
    try {
      text = await readFile(join(this.dir, USERS_FILE), 'utf8');
    } catch {
      return; // No accounts yet
    }
    // Important: if it is broken, **halt startup.** Skipping would start with 0 accounts and anyone could become "the first admin"
    let snapshot: UserSnapshot;
    try {
      snapshot = JSON.parse(text) as UserSnapshot;
    } catch (error) {
      // Startup error for the operator — the language comes from AAS_LANG (apps/api/src/lang.ts bootLang)
      throw new Error(fill(tr('{0}을(를) 읽지 못했습니다 — 손으로 고치거나 지운 뒤 다시 띄우십시오: {1}'), { 0: join(this.dir, USERS_FILE), 1: String(error) }));
    }
    this.restoreUsers(snapshot);
  }

  /** Account writes are serialized too — same reason as packages (two writers to the same .tmp corrupt it) */
  private userWrites: Promise<void> = Promise.resolve();

  private async persistUsers(): Promise<void> {
    const next = this.userWrites.catch(() => undefined).then(async () => {
      const target = join(this.dir, USERS_FILE);
      const temp = `${target}.tmp`;
      await writeFile(temp, JSON.stringify(this.userSnapshot()), 'utf8');
      await this.rename(temp, target);
    });
    this.userWrites = next;
    await next;
  }

  override async createUser(user: NewUser): Promise<UserRecord> {
    const record = await super.createUser(user);
    await this.persistUsers();
    return record;
  }

  override async createFirstUser(user: NewUser): Promise<UserRecord | undefined> {
    const record = await super.createFirstUser(user);
    if (record) await this.persistUsers();
    return record;
  }

  override async updateUser(
    id: string,
    patch: Parameters<InMemoryStore['updateUser']>[1],
  ): Promise<UserRecord | undefined> {
    const record = await super.updateUser(id, patch);
    if (record) await this.persistUsers();
    return record;
  }

  override async deleteUser(id: string): Promise<boolean> {
    const removed = await super.deleteUser(id);
    if (removed) await this.persistUsers();
    return removed;
  }

  override async touchUserLogin(id: string): Promise<void> {
    await super.touchUserLogin(id);
    await this.persistUsers();
  }

  /** The folder of one package — refuses ids that are not plain names */
  private packageDir(packageId: string): string {
    if (!PACKAGE_ID.test(packageId)) {
      throw new InvalidPackageIdError(fill(tr('패키지 id로 쓸 수 없는 값입니다: {0}'), { 0: JSON.stringify(packageId.slice(0, 80)) }));
    }
    return join(this.dir, packageId);
  }

  private async readValueFile(packageId: string): Promise<CollectedValue[]> {
    let text: string;
    try {
      text = await readFile(join(this.packageDir(packageId), VALUES_FILE), 'utf8');
    } catch {
      return [];
    }
    const values: CollectedValue[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        values.push(JSON.parse(line) as CollectedValue);
      } catch {
        // If power is lost mid-write, the last line gets truncated. Only that line is discarded
      }
    }
    return values;
  }

  /**
   * Important: when rewriting a whole file, **write to a temp file and rename it.**
   * Overwriting in place and losing power leaves a half-written file that cannot be opened next time.
   */
  /**
   * Per-package "write queue" — **serializes** writes to the same package.
   *
   * Important: without it things break (measured 2026-10-02). When two saves to the same package overlap, both write to the same
   *    `model.json.tmp`, the one that finishes first takes it away via rename, and
   *    the later one blows up with `ENOENT`. With bad luck it does not blow up, and **half-mixed content**
   *    becomes model.json — silently losing data is far worse.
   *    This happens immediately when a save and auto-fix overlap in the UI, or when two windows are open.
   */
  private readonly writes = new Map<string, Promise<void>>();

  private async persist(packageId: string): Promise<void> {
    // Snapshot **after** the previous write finishes — so a later write always holds newer content
    const previous = this.writes.get(packageId) ?? Promise.resolve();
    const next = previous
      // If an earlier failure blocked later ones, a package that failed once would never be saved again
      .catch(() => undefined)
      .then(() => this.writeModel(packageId));
    this.writes.set(packageId, next);
    try {
      await next;
    } finally {
      // Remove it if it was the last in line — no reason to keep holding a settled promise
      if (this.writes.get(packageId) === next) this.writes.delete(packageId);
    }
  }

  private async writeModel(packageId: string): Promise<void> {
    const folder = this.packageDir(packageId);
    await mkdir(folder, { recursive: true });
    const target = join(folder, MODEL_FILE);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(this.snapshot(packageId)), 'utf8');
    await this.rename(temp, target);
  }

  /** Queues the event line of every recorded row; `persistChange` appends it before the model (crash protocol) */
  protected override eventRecorded(row: StoredEvent): void {
    this.files.queueEvent(row);
  }

  /** Event line first, then the model — never the other way round, or a crash could leave a change without its event */
  private async persistChange(packageId: string): Promise<void> {
    await this.files.flushEvents();
    await this.persist(packageId);
  }

  // ── Everything below is "do the usual, then write to the folder" ───────────

  override async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    // Checked before the memory copy exists — otherwise a refused id would still be listed until restart
    if (input.id !== undefined) this.packageDir(input.id);
    const record = await super.importPackage(input);
    await this.persistChange(record.id);
    return record;
  }

  /** Refuses a malformed id here too — every package route starts with this lookup, so the answer is one 400 */
  override async getPackage(packageId: string): Promise<PackageRecord | undefined> {
    this.packageDir(packageId);
    return super.getPackage(packageId);
  }

  override async deletePackage(packageId: string): Promise<void> {
    const folder = this.packageDir(packageId);
    await super.deletePackage(packageId);
    await this.files.flushEvents();
    await rm(folder, { recursive: true, force: true });
    await this.files.packageDeleted(packageId);
  }

  override async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    this.packageDir(packageId);
    await super.putPackageFile(packageId, file);
    await this.persistChange(packageId);
  }

  override async deletePackageFile(packageId: string, part: string): Promise<void> {
    await super.deletePackageFile(packageId, part);
    await this.persistChange(packageId);
  }

  override async createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options?: CreateOptions,
  ): Promise<IdentifiableRecord> {
    const record = await super.createIdentifiable(packageId, content, options);
    await this.persistChange(packageId);
    return record;
  }

  override async updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<IdentifiableRecord> {
    const record = await super.updateIdentifiable(packageId, modelType, id, content, options);
    await this.persistChange(packageId);
    return record;
  }

  override async deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options?: WriteOptions,
  ): Promise<void> {
    await super.deleteIdentifiable(packageId, modelType, id, options);
    await this.persistChange(packageId);
  }

  override async appendValues(
    packageId: string,
    values: readonly CollectedValue[],
  ): Promise<void> {
    const folder = this.packageDir(packageId);
    await super.appendValues(packageId, values);
    if (values.length === 0) return;
    await mkdir(folder, { recursive: true });
    const lines = values.map((value) => JSON.stringify(value)).join('\n');
    await appendFile(join(folder, VALUES_FILE), `${lines}\n`, 'utf8');
  }

  override async pruneValues(before: string): Promise<number> {
    const removed = await super.pruneValues(before);
    if (removed === 0) return 0;
    // Rewrite values.jsonl whole from what remains — leave no trace of deleted values in the file either
    let cursor: string | undefined;
    do {
      const page = await this.listPackages(cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
      for (const record of page.items) await this.rewriteValueFile(record.id);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return removed;
  }

  // ── Integration — "do the usual, then write the integration file it touches" ──

  override async appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    const rows = await super.appendEvents(events);
    await this.files.flushEvents();
    return rows;
  }

  override async pruneEvents(before: string): Promise<number> {
    const removed = await super.pruneEvents(before);
    if (removed > 0) await this.files.compactEvents();
    return removed;
  }

  override async createSubscription(input: NewSubscription): Promise<SubscriptionRecord> {
    const record = await super.createSubscription(input);
    await this.files.writeConfig();
    return record;
  }

  override async updateSubscription(id: string, patch: SubscriptionPatch): Promise<SubscriptionRecord | undefined> {
    const record = await super.updateSubscription(id, patch);
    if (record) await this.files.writeConfig();
    return record;
  }

  override async deleteSubscription(id: string): Promise<boolean> {
    const removed = await super.deleteSubscription(id);
    if (removed) {
      await this.files.writeConfig();
      await this.files.compactDeliveries();
    }
    return removed;
  }

  override async enqueueDeliveries(rows: readonly { subscriptionId: string; eventSeq: number; eventId: string }[], now: string): Promise<number> {
    const inserted = await super.enqueueDeliveries(rows, now);
    if (inserted > 0) await this.files.appendNewDeliveries();
    return inserted;
  }

  override async claimDeliveries(now: string, limit: number, leaseMs: number, subscriptionId?: string): Promise<DeliveryRecord[]> {
    const claimed = await super.claimDeliveries(now, limit, leaseMs, subscriptionId);
    await this.files.appendDeliveries(claimed);
    return claimed;
  }

  override async completeDelivery(id: string, result: DeliveryResult): Promise<boolean> {
    const applied = await super.completeDelivery(id, result);
    const row = applied ? await super.getDelivery(id) : undefined;
    if (row) await this.files.appendDeliveries([row]);
    return applied;
  }

  override async extendLease(id: string, attempt: number, leaseUntil: string): Promise<boolean> {
    const extended = await super.extendLease(id, attempt, leaseUntil);
    const row = extended ? await super.getDelivery(id) : undefined;
    if (row) await this.files.appendDeliveries([row]);
    return extended;
  }

  override async redeliver(id: string, now: string): Promise<boolean> {
    const done = await super.redeliver(id, now);
    const row = done ? await super.getDelivery(id) : undefined;
    if (row) await this.files.appendDeliveries([row]);
    return done;
  }

  override async pruneDeliveries(succeededBefore: string, deadBefore: string): Promise<number> {
    const removed = await super.pruneDeliveries(succeededBefore, deadBefore);
    if (removed > 0) await this.files.compactDeliveries();
    return removed;
  }

  override async putServerIntegrationConfig(value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    const saved = await super.putServerIntegrationConfig(value, expectedRevision);
    await this.files.writeConfig();
    return saved;
  }

  override async putPackageIntegrationConfig(packageId: string, value: unknown, expectedRevision?: number): Promise<Versioned<unknown>> {
    const saved = await super.putPackageIntegrationConfig(packageId, value, expectedRevision);
    await this.files.writeConfig();
    return saved;
  }

  /** Event line first, then integration.json: a crash in between leaves a harmless "re-read" event, never a silent change */
  override async putExternalRefs(packageId: string, doc: ExternalRefsDoc, expectedRevision?: number): Promise<Versioned<ExternalRefsDoc>> {
    const saved = await super.putExternalRefs(packageId, doc, expectedRevision);
    await this.files.flushEvents();
    await this.files.writeConfig();
    return saved;
  }

  override async putExternalRefsBatch(items: readonly ExternalRefsBatchItem[]): Promise<Versioned<ExternalRefsDoc>[]> {
    const saved = await super.putExternalRefsBatch(items);
    await this.files.flushEvents();
    await this.files.writeConfig();
    return saved;
  }

  override async putRuntimeState(key: string, value: unknown, packageId?: string): Promise<void> {
    await super.putRuntimeState(key, value, packageId);
    this.files.stateChanged(key, packageId);
  }

  private async rewriteValueFile(packageId: string): Promise<void> {
    {
      const kept = await super.readValues(packageId, { limit: Number.MAX_SAFE_INTEGER });
      const path = join(this.packageDir(packageId), VALUES_FILE);
      if (kept.length === 0) {
        await rm(path, { force: true });
        return;
      }
      // readValues returns most recent first — the file keeps accumulation order (oldest first)
      const lines = [...kept].reverse().map((value) => JSON.stringify(value)).join('\n');
      await writeFile(path, `${lines}\n`, 'utf8');
    }
  }
}
