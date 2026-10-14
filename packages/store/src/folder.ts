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
 *
 * Important: accounts were once left out (2026-10-06, measured by a user). Only packages were written and accounts stayed in memory,
 *    so after creating an admin and restarting the server, the accounts vanished and it went back to "create the first admin".
 *    In the meantime the server sits empty **without even being in protected mode**, so it was also a security issue.
 *
 * Important: why collected values are not put into model.json: collection runs every few seconds.
 *    Rewriting a multi-MB file including attachments each time grinds the disk. So they were split into appends.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AasxPackage } from '@aas/aasx';
import { InMemoryStore, type PackageSnapshot, type UserSnapshot } from './memory.js';
import type {
  CollectedValue,
  IdentifiableModelType,
  IdentifiableRecord,
  PackageFileRecord,
  PackageRecord,
  NewUser,
  UserRecord,
  WriteOptions, CreateOptions } from './types.js';

const MODEL_FILE = 'model.json';
const USERS_FILE = 'users.json';
const VALUES_FILE = 'values.jsonl';

export class FolderStore extends InMemoryStore {
  constructor(
    private readonly dir: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    super(now);
  }

  /** Loads the folder. Creates it if it does not exist */
  override async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.readUsers();
    const entries = await readdir(this.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const modelPath = join(this.dir, entry.name, MODEL_FILE);
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
      // i18n-ignore — error shown to the operator at startup (there is no request, so no language either)
      throw new Error(`${join(this.dir, USERS_FILE)}을(를) 읽지 못했습니다 — 손으로 고치거나 지운 뒤 다시 띄우십시오: ${String(error)}`);
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
      await rename(temp, target);
    });
    this.userWrites = next;
    await next;
  }

  override async createUser(user: NewUser): Promise<UserRecord> {
    const record = await super.createUser(user);
    await this.persistUsers();
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

  private async readValueFile(packageId: string): Promise<CollectedValue[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir, packageId, VALUES_FILE), 'utf8');
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
    const folder = join(this.dir, packageId);
    await mkdir(folder, { recursive: true });
    const target = join(folder, MODEL_FILE);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(this.snapshot(packageId)), 'utf8');
    await rename(temp, target);
  }

  // ── Everything below is "do the usual, then write to the folder" ───────────

  override async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    const record = await super.importPackage(input);
    await this.persist(record.id);
    return record;
  }

  override async deletePackage(packageId: string): Promise<void> {
    await super.deletePackage(packageId);
    await rm(join(this.dir, packageId), { recursive: true, force: true });
  }

  override async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    await super.putPackageFile(packageId, file);
    await this.persist(packageId);
  }

  override async deletePackageFile(packageId: string, part: string): Promise<void> {
    await super.deletePackageFile(packageId, part);
    await this.persist(packageId);
  }

  override async createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options?: CreateOptions,
  ): Promise<IdentifiableRecord> {
    const record = await super.createIdentifiable(packageId, content, options);
    await this.persist(packageId);
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
    await this.persist(packageId);
    return record;
  }

  override async deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options?: WriteOptions,
  ): Promise<void> {
    await super.deleteIdentifiable(packageId, modelType, id, options);
    await this.persist(packageId);
  }

  override async appendValues(
    packageId: string,
    values: readonly CollectedValue[],
  ): Promise<void> {
    await super.appendValues(packageId, values);
    if (values.length === 0) return;
    const folder = join(this.dir, packageId);
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

  private async rewriteValueFile(packageId: string): Promise<void> {
    {
      const kept = await super.readValues(packageId, { limit: Number.MAX_SAFE_INTEGER });
      const path = join(this.dir, packageId, VALUES_FILE);
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
