/**
 * In-memory store — for development and testing.
 *
 * Passes **the same conformance tests** as PostgresStore (test/conformance.ts).
 * Set up so that the tests break the moment the two implementations' behavior diverges.
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { fill, tr } from '@aas/core';
import {
  deriveColumns,
  flattenEnvironment,
  flattenPackageFiles,
  toAasxPackage,
  toEnvironment,
} from './convert.js';
import { actorFields } from './actor.js';
import {
  type CollectedValue,
  type NewUser,
  type UserRecord,
  type ValueQuery,
  ConflictError,
  InvalidContentError,
  NotFoundError,
  type AasStore,
  type HistoryRecord,
  type IdentifiableModelType,
  type IdentifiableRecord,
  type ListQuery,
  type PackageFileRecord,
  type PackageFileRole,
  type PackageRecord,
  type PageQuery,
  type PageResult,
  type WriteOptions, type CreateOptions,
  type PackageScope } from './types.js';

const DEFAULT_LIMIT = 100;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface PackageState {
  record: PackageRecord;
  /** Collected values — kept alongside the model but neither references the other (Option A) */
  values: CollectedValue[];
  files: PackageFileRecord[];
  /** uid → record */
  identifiables: Map<string, IdentifiableRecord>;
  history: HistoryRecord[];
  nextUid: number;
  nextOrdinal: number;
}

export class InMemoryStore implements AasStore {
  private readonly packages = new Map<string, PackageState>();
  private nextPackageId = 1;
  /** Users — id → record. login is lowercased for lookup */
  private readonly users = new Map<string, UserRecord>();
  private nextUserId = 1;
  /** Clock injection — left open so tests can run deterministically */
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async init(): Promise<void> {
    // Nothing to prepare for the in-memory store
  }

  private state(packageId: string): PackageState {
    const state = this.packages.get(packageId);
    if (!state) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
    return state;
  }

  private touch(state: PackageState): void {
    state.record.revision += 1;
    state.record.updatedAt = this.now();
  }

  private find(
    state: PackageState,
    modelType: IdentifiableModelType,
    id: string,
  ): IdentifiableRecord | undefined {
    // Duplicate ids are a measured defect (KOSMO-CD-5), so they really do come in. The first one is treated as representative
    const matches = [...state.identifiables.values()]
      .filter((r) => r.modelType === modelType && r.id === id)
      .sort((a, b) => a.ordinal - b.ordinal);
    return matches[0];
  }

  async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    const id = input.id ?? `pkg_${this.nextPackageId++}`;
    if (this.packages.has(id)) {
      throw new InvalidContentError(fill(tr('이미 있는 패키지 id입니다: {0}'), { 0: id }));
    }
    const at = this.now();
    const record: PackageRecord = {
      id,
      name: input.name,
      specPart: input.package.specPart,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      // Important: no key when absent — do not mix "shared" with "owner is an empty string"
      ...(input.owner ? { owner: input.owner } : {}),
    };
    const state: PackageState = {
      record,
      files: [...flattenPackageFiles(input.package), ...(input.keep ?? [])].map((f) => ({ ...f, data: f.data.slice() })),
      identifiables: new Map(),
      values: [],
      history: [],
      nextUid: 1,
      nextOrdinal: 0,
    };

    for (const { content, ordinal } of flattenEnvironment(input.package.environment)) {
      const derived = deriveColumns(content);
      const uid = String(state.nextUid++);
      state.identifiables.set(uid, {
        uid,
        packageId: id,
        ...derived,
        ordinal,
        content: clone(content),
        revision: 1,
        updatedAt: at,
      });
      state.nextOrdinal = Math.max(state.nextOrdinal, ordinal + 1);
    }

    this.packages.set(id, state);
    return clone(record);
  }

  async exportPackage(packageId: string): Promise<AasxPackage> {
    const state = this.state(packageId);
    const env = toEnvironment([...state.identifiables.values()].map((r) => clone(r)));
    return toAasxPackage(
      clone(state.record),
      state.files.map((f) => ({ ...f, data: f.data.slice() })),
      env,
    );
  }

  async getPackage(packageId: string): Promise<PackageRecord | undefined> {
    const state = this.packages.get(packageId);
    return state ? clone(state.record) : undefined;
  }

  async listPackages(page: PageQuery = {}, scope?: PackageScope): Promise<PageResult<PackageRecord>> {
    const all = [...this.packages.values()]
      .map((s) => s.record)
      // Paginate **after** filtering — in the other order a page comes up short and whether a next page exists is wrong
      .filter((r) => scope === undefined || r.owner === undefined || r.owner === scope.owner)
      .sort((a, b) => a.id.localeCompare(b.id));
    return paginate(all, page, (r) => r.id, clone);
  }

  async deletePackage(packageId: string): Promise<void> {
    if (!this.packages.delete(packageId)) throw new NotFoundError(fill(tr('패키지 {0}'), { 0: packageId }));
  }

  async getEnvironment(packageId: string): Promise<Environment> {
    const state = this.state(packageId);
    return toEnvironment([...state.identifiables.values()].map((r) => clone(r)));
  }

  async appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void> {
    const state = this.state(packageId);
    for (const value of values) state.values.push({ ...value });
    // Collection does not change the model, so the package revision is not bumped — it is not an edit
  }

  async readValues(packageId: string, query: ValueQuery = {}): Promise<CollectedValue[]> {
    const state = this.state(packageId);
    const at = (v: CollectedValue): string => (query.basis === 'received' ? (v.receivedAt ?? v.observedAt) : v.observedAt);
    return state.values
      .filter((v) => query.interfaceName === undefined || v.interfaceName === query.interfaceName)
      .filter((v) => query.propertyName === undefined || v.propertyName === query.propertyName)
      .filter((v) => query.from === undefined || at(v) >= query.from)
      .filter((v) => query.to === undefined || at(v) < query.to)
      .sort((a, b) => at(b).localeCompare(at(a)))
      .slice(0, query.limit ?? 1000)
      .map((v) => ({ ...v }));
  }

  async pruneValues(before: string): Promise<number> {
    let removed = 0;
    for (const state of this.packages.values()) {
      // Judged by receive time — for constant-value tags the device time is frozen, so deleting by device time would also delete values just received (2026-10-14)
      const kept = state.values.filter((v) => (v.receivedAt ?? v.observedAt) >= before);
      removed += state.values.length - kept.length;
      state.values = kept;
    }
    return removed;
  }

  async packageFiles(packageId: string): Promise<PackageFileRecord[]> {
    return this.state(packageId).files.map((f) => ({ ...f, data: f.data.slice() }));
  }

  async putPackageFile(packageId: string, file: PackageFileRecord): Promise<void> {
    const state = this.state(packageId);
    const stored: PackageFileRecord = { ...file, data: file.data.slice() };
    const index = state.files.findIndex((f) => f.part === file.part);
    if (index >= 0) state.files[index] = stored;
    else state.files.push(stored);
    this.touch(state);
  }

  async deletePackageFile(packageId: string, part: string): Promise<void> {
    const state = this.state(packageId);
    const index = state.files.findIndex((f) => f.part === part);
    if (index < 0) throw new NotFoundError(fill(tr('파트 {0}'), { 0: part }));
    state.files.splice(index, 1);
    this.touch(state);
  }

  async listIdentifiables(
    packageId: string,
    modelType: IdentifiableModelType,
    query: ListQuery = {},
  ): Promise<PageResult<IdentifiableRecord>> {
    const state = this.state(packageId);
    const all = [...state.identifiables.values()]
      .filter((r) => r.modelType === modelType)
      .filter((r) => query.idShort === undefined || r.idShort === query.idShort)
      .filter((r) => query.semanticId === undefined || r.semanticId === query.semanticId)
      .filter((r) => query.assetKind === undefined || r.assetKind === query.assetKind)
      .sort((a, b) => a.ordinal - b.ordinal);
    return paginate(all, query, (r) => String(r.ordinal), clone);
  }

  async getIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<IdentifiableRecord | undefined> {
    const found = this.find(this.state(packageId), modelType, id);
    return found ? clone(found) : undefined;
  }

  async createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options: CreateOptions = {},
  ): Promise<IdentifiableRecord> {
    const state = this.state(packageId);
    const derived = deriveColumns(content);
    if (this.find(state, derived.modelType, derived.id)) {
      throw new InvalidContentError(fill(tr('이미 있는 id입니다: {0}'), { 0: derived.id }));
    }
    const uid = String(state.nextUid++);
    // At the given position if specified, otherwise at the end. If the given position is past the end, push the next position beyond it too
    const ordinal = options.ordinal ?? state.nextOrdinal++;
    state.nextOrdinal = Math.max(state.nextOrdinal, ordinal + 1);
    const record: IdentifiableRecord = {
      uid,
      packageId,
      ...derived,
      ordinal,
      content: clone(content),
      revision: 1,
      updatedAt: this.now(),
    };
    state.identifiables.set(uid, record);
    this.touch(state);
    return clone(record);
  }

  async updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options: WriteOptions = {},
  ): Promise<IdentifiableRecord> {
    const state = this.state(packageId);
    const current = this.find(state, modelType, id);
    if (!current) throw new NotFoundError(`${modelType} ${id}`);
    checkRevision(options, current.revision);

    const derived = deriveColumns(content);
    if (derived.modelType !== modelType || derived.id !== id) {
      throw new InvalidContentError(
        fill(tr('본문의 modelType·id가 경로와 다릅니다: {0} {1}. id를 바꾸려면 참조 무결성 때문에 Quick Fix의 교정 경로를 쓰십시오.'), {
          0: derived.modelType,
          1: derived.id,
        }),
      );
    }

    state.history.unshift({
      uid: current.uid,
      packageId,
      modelType,
      id,
      revision: current.revision,
      content: clone(current.content),
      operation: 'update',
      changedAt: this.now(),
      ...actorFields(options.actor),
    });

    const updated: IdentifiableRecord = {
      ...current,
      ...derived,
      content: clone(content),
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    state.identifiables.set(current.uid, updated);
    this.touch(state);
    return clone(updated);
  }

  async deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options: WriteOptions = {},
  ): Promise<void> {
    const state = this.state(packageId);
    const current = this.find(state, modelType, id);
    if (!current) throw new NotFoundError(`${modelType} ${id}`);
    checkRevision(options, current.revision);

    state.history.unshift({
      uid: current.uid,
      packageId,
      modelType,
      id,
      revision: current.revision,
      content: clone(current.content),
      operation: 'delete',
      changedAt: this.now(),
      ...actorFields(options.actor),
    });
    state.identifiables.delete(current.uid);
    this.touch(state);
  }

  async history(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<HistoryRecord[]> {
    const state = this.state(packageId);
    return state.history
      .filter((h) => h.modelType === modelType && h.id === id)
      .map((h) => clone(h));
  }

  // ── Users (2026-10-02) ────────────────────────────────────────────────────
  // Important: login is stored and looked up **lowercased**. People treat Kim and kim as the same name,
  //    but the table's UNIQUE sees them as different, so if both were created nobody could tell who gets logged in.

  async findUserByLogin(login: string): Promise<UserRecord | undefined> {
    const key = login.trim().toLowerCase();
    for (const user of this.users.values()) if (user.login === key) return clone(user);
    return undefined;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const found = this.users.get(id);
    return found ? clone(found) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].map((user) => clone(user));
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    const login = user.login.trim().toLowerCase();
    if (login === '') throw new Error(tr('로그인 이름이 비어 있습니다.'));
    if (await this.findUserByLogin(login)) throw new Error(fill(tr('이미 있는 로그인 이름입니다: {0}'), { 0: login }));
    const record: UserRecord = {
      id: `user_${this.nextUserId++}`,
      login,
      displayName: user.displayName.trim() === '' ? login : user.displayName.trim(),
      role: user.role,
      passwordHash: user.passwordHash,
      disabled: false,
      createdAt: this.now(),
      // Important: empty strings do not create a key — do not mix "not entered" with "entered an empty value"
      ...(user.email?.trim() ? { email: user.email.trim() } : {}),
      ...(user.company?.trim() ? { company: user.company.trim() } : {}),
      ...(user.consentAt ? { consentAt: user.consentAt } : {}),
    };
    this.users.set(record.id, record);
    return clone(record);
  }

  async updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email' | 'company'>>,
  ): Promise<UserRecord | undefined> {
    const found = this.users.get(id);
    if (!found) return undefined;
    // Important: change only what is given — applying undefined would wipe out valid values
    if (patch.displayName !== undefined) found.displayName = patch.displayName;
    if (patch.role !== undefined) found.role = patch.role;
    if (patch.passwordHash !== undefined) found.passwordHash = patch.passwordHash;
    if (patch.disabled !== undefined) found.disabled = patch.disabled;
    if (patch.email !== undefined) {
      if (patch.email.trim() === '') delete found.email;
      else found.email = patch.email.trim();
    }
    // Same for the company name — an empty string means "clear it" (2026-10-08, my account settings)
    if (patch.company !== undefined) {
      if (patch.company.trim() === '') delete found.company;
      else found.company = patch.company.trim();
    }
    return clone(found);
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  async touchUserLogin(id: string): Promise<void> {
    const found = this.users.get(id);
    if (found) found.lastLoginAt = this.now();
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  // ── Access points used by the folder store ─────────────────────────────────
  // FolderStore (the store that keeps files in a folder) saves and restores this state as-is.
  // Exposing this means FolderStore does not have to rebuild the internal data structures,
  // and there is no room for the two stores' behavior to diverge (they run the same conformance tests).

  /** Extracts all accounts in a JSON-transferable form — including the next id number */
  userSnapshot(): UserSnapshot {
    return { users: [...this.users.values()].map((user) => clone(user)), nextUserId: this.nextUserId };
  }

  /** Restores what userSnapshot() extracted */
  restoreUsers(snapshot: UserSnapshot): void {
    this.users.clear();
    for (const user of snapshot.users) this.users.set(user.id, clone(user));
    // Important: if the counter is not restored, a deleted account's id gets reattached to a new account — mixing up the audit log's "who"
    const highest = Math.max(0, ...snapshot.users.map((user) => Number(/^user_(\d+)$/.exec(user.id)?.[1] ?? 0)));
    this.nextUserId = Math.max(snapshot.nextUserId, highest + 1);
  }

  /** All stored package ids */
  packageIds(): string[] {
    return [...this.packages.keys()];
  }

  /** Extracts one package's state in a JSON-transferable form. Collected values are excluded (stored separately) */
  snapshot(packageId: string): PackageSnapshot {
    const state = this.state(packageId);
    return {
      record: clone(state.record),
      files: state.files.map((f) => ({
        part: f.part,
        role: f.role,
        contentType: f.contentType,
        // Important: Uint8Array does not survive JSON as-is — it becomes {"0":12,...} and breaks on restore
        dataBase64: Buffer.from(f.data).toString('base64'),
      })),
      identifiables: [...state.identifiables.values()].map((r) => clone(r)),
      history: state.history.map((h) => clone(h)),
      nextUid: state.nextUid,
      nextOrdinal: state.nextOrdinal,
    };
  }

  /** Restores what snapshot() extracted. Collected values are added separately */
  restore(snapshot: PackageSnapshot, values: readonly CollectedValue[] = []): void {
    const identifiables = new Map<string, IdentifiableRecord>();
    for (const record of snapshot.identifiables) identifiables.set(record.uid, clone(record));
    this.packages.set(snapshot.record.id, {
      record: clone(snapshot.record),
      values: values.map((v) => clone(v)),
      files: snapshot.files.map((f) => ({
        part: f.part,
        role: f.role,
        contentType: f.contentType,
        data: new Uint8Array(Buffer.from(f.dataBase64, 'base64')),
      })),
      identifiables,
      history: snapshot.history.map((h) => clone(h)),
      nextUid: snapshot.nextUid,
      nextOrdinal: snapshot.nextOrdinal,
    });
    // Advance the counter so packages created after restoring do not collide with existing ids
    const match = /^pkg_(\d+)$/.exec(snapshot.record.id);
    if (match) this.nextPackageId = Math.max(this.nextPackageId, Number(match[1]) + 1);
  }
}

/** Accounts kept in the folder — passwords exist only as scrypt hashes */
export interface UserSnapshot {
  users: UserRecord[];
  nextUserId: number;
}

/** The form kept in the folder — identical to internal state except that Uint8Array is converted to base64 */
export interface PackageSnapshot {
  record: PackageRecord;
  files: { part: string; role: PackageFileRole; contentType: string; dataBase64: string }[];
  identifiables: IdentifiableRecord[];
  history: HistoryRecord[];
  nextUid: number;
  nextOrdinal: number;
}

function checkRevision(options: WriteOptions, actual: number): void {
  if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
    throw new ConflictError(options.expectedRevision, actual);
  }
}

/** The cursor is the sort key itself — returns limit items after it */
function paginate<T>(
  all: readonly T[],
  page: PageQuery,
  keyOf: (item: T) => string,
  copy: (item: T) => T,
): PageResult<T> {
  const limit = page.limit ?? DEFAULT_LIMIT;
  const start = page.cursor === undefined ? 0 : all.findIndex((item) => keyOf(item) === page.cursor) + 1;
  const slice = all.slice(start, start + limit);
  const result: PageResult<T> = { items: slice.map(copy) };
  const last = slice[slice.length - 1];
  if (last !== undefined && start + slice.length < all.length) result.cursor = keyOf(last);
  return result;
}
