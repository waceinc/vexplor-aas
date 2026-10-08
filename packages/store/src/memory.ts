/**
 * 인메모리 저장소 — 개발·테스트용.
 *
 * PostgresStore와 **같은 적합성 테스트**를 통과한다(test/conformance.ts).
 * 두 구현의 동작이 갈리는 순간 그 테스트가 깨지도록 해 뒀다.
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
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
  /** 수집값 — 모델과 같은 자리에 두지만 서로 참조하지 않는다(A안) */
  values: CollectedValue[];
  files: PackageFileRecord[];
  /** uid → 레코드 */
  identifiables: Map<string, IdentifiableRecord>;
  history: HistoryRecord[];
  nextUid: number;
  nextOrdinal: number;
}

export class InMemoryStore implements AasStore {
  private readonly packages = new Map<string, PackageState>();
  private nextPackageId = 1;
  /** 사용자 — id → 레코드. login은 소문자로 맞춰 찾는다 */
  private readonly users = new Map<string, UserRecord>();
  private nextUserId = 1;
  /** 시각 주입 — 테스트에서 결정론적으로 쓰기 위해 열어 둔다 */
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async init(): Promise<void> {
    // 인메모리는 준비할 것이 없다
  }

  private state(packageId: string): PackageState {
    const state = this.packages.get(packageId);
    if (!state) throw new NotFoundError(`패키지 ${packageId}`);
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
    // id 중복은 실측 결함(KOSMO-CD-5)이라 실제로 들어온다. 먼저 나온 것을 대표로 본다
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
      throw new InvalidContentError(`이미 있는 패키지 id입니다: ${id}`);
    }
    const at = this.now();
    const record: PackageRecord = {
      id,
      name: input.name,
      specPart: input.package.specPart,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      // 🔴 없으면 키를 만들지 않는다 — 「공용」과 「주인이 빈 문자열」을 섞지 않는다
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
      // 거른 **뒤에** 쪽을 나눈다 — 순서가 바뀌면 한 쪽이 덜 차고 다음 쪽 유무가 틀린다
      .filter((r) => scope === undefined || r.owner === undefined || r.owner === scope.owner)
      .sort((a, b) => a.id.localeCompare(b.id));
    return paginate(all, page, (r) => r.id, clone);
  }

  async deletePackage(packageId: string): Promise<void> {
    if (!this.packages.delete(packageId)) throw new NotFoundError(`패키지 ${packageId}`);
  }

  async getEnvironment(packageId: string): Promise<Environment> {
    const state = this.state(packageId);
    return toEnvironment([...state.identifiables.values()].map((r) => clone(r)));
  }

  async appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void> {
    const state = this.state(packageId);
    for (const value of values) state.values.push({ ...value });
    // 수집은 모델을 바꾸지 않으므로 패키지 리비전을 올리지 않는다 — 편집이 아니다
  }

  async readValues(packageId: string, query: ValueQuery = {}): Promise<CollectedValue[]> {
    const state = this.state(packageId);
    return state.values
      .filter((v) => query.interfaceName === undefined || v.interfaceName === query.interfaceName)
      .filter((v) => query.propertyName === undefined || v.propertyName === query.propertyName)
      .filter((v) => query.from === undefined || v.observedAt >= query.from)
      .filter((v) => query.to === undefined || v.observedAt < query.to)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .slice(0, query.limit ?? 1000)
      .map((v) => ({ ...v }));
  }

  async pruneValues(before: string): Promise<number> {
    let removed = 0;
    for (const state of this.packages.values()) {
      const kept = state.values.filter((v) => v.observedAt >= before);
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
    if (index < 0) throw new NotFoundError(`파트 ${part}`);
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
      throw new InvalidContentError(`이미 있는 id입니다: ${derived.id}`);
    }
    const uid = String(state.nextUid++);
    // 자리를 지정하면 그 자리에, 아니면 맨 뒤에. 지정한 자리가 끝보다 뒤면 다음 자리도 그 뒤로 민다
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
        `본문의 modelType·id가 경로와 다릅니다: ${derived.modelType} ${derived.id}. ` +
          'id를 바꾸려면 참조 무결성 때문에 Quick Fix의 교정 경로를 쓰십시오.',
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

  // ── 사용자 (2026-10-02) ───────────────────────────────────────────────────
  // 🔴 login은 **소문자로 맞춰** 넣고 찾는다. 사람은 Kim과 kim을 같은 이름으로 여기는데
  //    표의 UNIQUE는 다른 것으로 보아, 둘 다 만들어지면 누가 로그인되는지 알 수 없다.

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
    if (login === '') throw new Error('로그인 이름이 비어 있습니다.');
    if (await this.findUserByLogin(login)) throw new Error(`이미 있는 로그인 이름입니다: ${login}`);
    const record: UserRecord = {
      id: `user_${this.nextUserId++}`,
      login,
      displayName: user.displayName.trim() === '' ? login : user.displayName.trim(),
      role: user.role,
      passwordHash: user.passwordHash,
      disabled: false,
      createdAt: this.now(),
      // 🔴 빈 문자열은 키를 만들지 않는다 — 「안 적었다」와 「빈 값을 적었다」를 섞지 않는다
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
    // 🔴 준 것만 바꾼다 — undefined를 얹으면 멀쩡한 값이 지워진다
    if (patch.displayName !== undefined) found.displayName = patch.displayName;
    if (patch.role !== undefined) found.role = patch.role;
    if (patch.passwordHash !== undefined) found.passwordHash = patch.passwordHash;
    if (patch.disabled !== undefined) found.disabled = patch.disabled;
    if (patch.email !== undefined) {
      if (patch.email.trim() === '') delete found.email;
      else found.email = patch.email.trim();
    }
    // 회사명도 같다 — 빈 문자열은 「지우라」는 뜻(2026-10-08 내 계정 설정)
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

  // ── 폴더 보관함이 쓰는 창구 ────────────────────────────────────────────────
  // FolderStore(폴더에 파일로 남기는 보관함)가 이 상태를 그대로 저장·복원한다.
  // 여기를 열어 두는 대신 FolderStore가 내부 자료구조를 다시 만들지 않아도 되고,
  // 두 보관함의 동작이 갈릴 여지도 없다(같은 적합성 테스트를 돌린다).

  /** 계정 전부를 JSON으로 옮길 수 있는 형태로 꺼낸다 — 다음 번호까지 함께 */
  userSnapshot(): UserSnapshot {
    return { users: [...this.users.values()].map((user) => clone(user)), nextUserId: this.nextUserId };
  }

  /** userSnapshot()이 꺼낸 것을 되돌린다 */
  restoreUsers(snapshot: UserSnapshot): void {
    this.users.clear();
    for (const user of snapshot.users) this.users.set(user.id, clone(user));
    // 🔴 번호를 되돌리지 않으면 지운 계정의 id가 새 계정에 다시 붙는다 — 감사 기록의 「누가」가 섞인다
    const highest = Math.max(0, ...snapshot.users.map((user) => Number(/^user_(d+)$/.exec(user.id)?.[1] ?? 0)));
    this.nextUserId = Math.max(snapshot.nextUserId, highest + 1);
  }

  /** 저장된 패키지 id 전부 */
  packageIds(): string[] {
    return [...this.packages.keys()];
  }

  /** 한 패키지의 상태를 JSON으로 옮길 수 있는 형태로 꺼낸다. 수집값은 뺀다(따로 쌓는다) */
  snapshot(packageId: string): PackageSnapshot {
    const state = this.state(packageId);
    return {
      record: clone(state.record),
      files: state.files.map((f) => ({
        part: f.part,
        role: f.role,
        contentType: f.contentType,
        // 🔴 Uint8Array는 JSON에 그대로 담기지 않는다 — {"0":12,...}가 되어 되살릴 때 깨진다
        dataBase64: Buffer.from(f.data).toString('base64'),
      })),
      identifiables: [...state.identifiables.values()].map((r) => clone(r)),
      history: state.history.map((h) => clone(h)),
      nextUid: state.nextUid,
      nextOrdinal: state.nextOrdinal,
    };
  }

  /** snapshot()이 꺼낸 것을 되돌린다. 수집값은 따로 넣는다 */
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
    // 되돌린 뒤 새로 만드는 패키지가 기존 id와 부딪히지 않도록 번호를 밀어 둔다
    const match = /^pkg_(\d+)$/.exec(snapshot.record.id);
    if (match) this.nextPackageId = Math.max(this.nextPackageId, Number(match[1]) + 1);
  }
}

/** 폴더에 남기는 계정 — 비밀번호는 scrypt 해시로만 있다 */
export interface UserSnapshot {
  users: UserRecord[];
  nextUserId: number;
}

/** 폴더에 남기는 형태 — Uint8Array만 base64로 바꾼 것 외에는 내부 상태 그대로다 */
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

/** cursor는 정렬 키 그 자체다 — 그 뒤부터 limit개를 준다 */
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
