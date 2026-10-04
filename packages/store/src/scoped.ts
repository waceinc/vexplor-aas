/**
 * 작업 공간 — 「누구의 눈으로 저장소를 보는가」.
 *
 * 저장소를 한 겹 감싸, 지금 요청의 작업 공간에 **보이는 것만** 내준다.
 *
 * 🔴 **왜 길목(api.ts)에서 packageId만 검사하지 않는가.** 라우트 일곱 군데가 패키지를
 *    **전부 나열**한다 — 번들이 공정에 묶인 설비를 찾을 때, 레지스트리가 자산 ID로 찾을 때,
 *    계층에 다른 파일을 이어 붙일 때. 주소의 packageId만 지키면 이 길로 남의 파일이 샌다.
 *    저장소는 모든 길이 지나는 한 곳이라, 여기서 막으면 새 라우트를 만들어도 빠질 자리가 없다.
 *    (감사 기록의 「누가」를 한 곳에서 깐 것과 같은 이유다 — actor.ts)
 *
 * 🔴 **문맥이 없으면 전부 보인다.** 요청 밖에서 도는 것들 — 주기 수집 · OPC UA 노출 ·
 *    보존 기간 정리 · 템플릿 올리기 — 은 서버 자신이고 모든 패키지를 다뤄야 한다.
 *    팀이 같이 쓰는 서버(기본)도 문맥을 깔지 않는다. 그래서 **이 겹을 씌워도 아무 것도
 *    달라지지 않는다** — 나누기를 켠 서버에서만 일한다.
 *
 * 규칙은 셋이다.
 *   ① 내 것            읽고 고친다
 *   ② 주인 없는 것      누구나 **읽기만** (기동 때 올린 템플릿 — 「가져오기」의 출처)
 *   ③ 남의 것          **없는 것처럼** 보인다 (403이 아니라 404 — 있다는 사실도 알려 주지 않는다)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';

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

export interface Workspace {
  /** 작업 공간 열쇠 — 새로 올리는 패키지의 주인이 된다 */
  key: string;
  /** 전부 본다 — 관리자와 기계(API 키). 운영하려면 남의 것도 봐야 한다 */
  seesAll: boolean;
}

const storage = new AsyncLocalStorage<Workspace>();

/** `fn`이 도는 동안 저장소를 `workspace`의 눈으로 본다. undefined면 깔지 않는다(전부 보인다) */
export function runInWorkspace<T>(workspace: Workspace | undefined, fn: () => T): T {
  return workspace === undefined ? fn() : storage.run(workspace, fn);
}

export function currentWorkspace(): Workspace | undefined {
  return storage.getStore();
}

/**
 * 지금 작업 공간에서 이 패키지가 보이는가. 문맥이 없으면 전부 보인다.
 *
 * 저장소를 거치지 않고 **미리 모아 둔 것**(주기 수집의 지난 결과 같은)을 내줄 때 쓴다 —
 * 그런 것은 겹이 걸러 주지 못하므로 내주는 자리에서 직접 물어야 한다.
 */
export function visibleInWorkspace(record: Pick<PackageRecord, 'owner'> | undefined): boolean {
  const workspace = currentWorkspace();
  if (!workspace) return true;
  if (!record) return false;
  return workspace.seesAll || record.owner === undefined || record.owner === workspace.key;
}

/** 저장소에 작업 공간 겹을 씌운다 */
export function scopeStore(base: AasStore): AasStore {
  return new ScopedStore(base);
}

/**
 * 🔴 `implements AasStore`를 **손으로 다 적는다**(Proxy로 뭉뚱그리지 않는다).
 *    저장소에 새 메서드가 생기면 여기가 **컴파일되지 않는다** — 그 메서드가 남의 것을
 *    볼 수 있는지 누군가 정해야 넘어간다. 조용히 통과하는 것이 가장 나쁘다.
 */
class ScopedStore implements AasStore {
  constructor(private readonly base: AasStore) {}

  // ── 보이는가 · 고칠 수 있는가 ─────────────────────────────────────────────

  /** 규칙은 visibleInWorkspace 한 곳에 있다 — 두 군데에 따로 적으면 한쪽만 고쳐진다 */
  private canRead(record: PackageRecord, _workspace: Workspace): boolean {
    return visibleInWorkspace(record);
  }

  /** 읽을 수 있어야 한다. 아니면 **없는 것**으로 답한다 */
  private async readable(packageId: string): Promise<void> {
    const workspace = currentWorkspace();
    if (!workspace) return;
    const record = await this.base.getPackage(packageId);
    // 진짜 없는 것과 남의 것이 **같은 답**이어야 한다 — 다르면 id를 찍어 보며 있는지 알아낼 수 있다
    if (!record || !this.canRead(record, workspace)) throw new NotFoundError(`패키지 ${packageId}`);
  }

  /** 고칠 수 있어야 한다. 남의 것은 없는 것, 공용은 읽기 전용 */
  private async writable(packageId: string): Promise<void> {
    const workspace = currentWorkspace();
    if (!workspace) return;
    const record = await this.base.getPackage(packageId);
    if (!record || !this.canRead(record, workspace)) throw new NotFoundError(`패키지 ${packageId}`);
    if (!workspace.seesAll && record.owner !== workspace.key) {
      throw new ForbiddenError(
        '함께 쓰는 파일이라 고칠 수 없습니다 — 「다른 파일에서 가져오기」로 내 파일에 가져와 고치십시오.',
      );
    }
  }

  // ── 초기화 ────────────────────────────────────────────────────────────────
  init(): Promise<void> {
    return this.base.init();
  }

  // ── 패키지 ────────────────────────────────────────────────────────────────
  async importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    owner?: string | null;
  }): Promise<PackageRecord> {
    const workspace = currentWorkspace();
    // 🔴 명시로 준 주인이 이긴다 — 「통째로 바꾸기」가 원래 주인을 지켜서 넘긴다(packages.ts).
    //    관리자가 남의 파일을 바꿔 줬다고 그 파일이 관리자 것이 되면 안 된다
    //    `null`은 「일부러 공용」 — 공용 파일을 바꾼 뒤에도 공용으로 남긴다
    const owner = input.owner === null ? null : (input.owner ?? workspace?.key ?? null);
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
    // 문맥이 없거나 전부 보는 쪽이면 부른 쪽이 준 범위 그대로(대개 없음)
    if (!workspace || workspace.seesAll) return this.base.listPackages(page, scope);
    // 🔴 부른 쪽이 준 범위를 **무시한다** — 라우트가 남의 열쇠를 넘겨 엿보는 길을 닫는다
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

  // ── 비모델 파트 ───────────────────────────────────────────────────────────
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

  // ── 수집값 ────────────────────────────────────────────────────────────────
  async appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void> {
    await this.writable(packageId);
    return this.base.appendValues(packageId, values);
  }

  async readValues(packageId: string, query?: ValueQuery): Promise<CollectedValue[]> {
    await this.readable(packageId);
    return this.base.readValues(packageId, query);
  }

  /**
   * 보존 기간 정리 — **모든 패키지**의 오래된 값을 지운다.
   * 🔴 작업 공간 안에서는 부르지 못하게 한다. 한 방문자의 요청이 남의 수집값까지 지우면 안 된다.
   *    (지금은 서버 자신만 부른다 — 요청 문맥 밖이다)
   */
  pruneValues(before: string): Promise<number> {
    const workspace = currentWorkspace();
    if (workspace && !workspace.seesAll) {
      throw new ForbiddenError('수집값 정리는 서버만 할 수 있습니다.');
    }
    return this.base.pruneValues(before);
  }

  async history(packageId: string, modelType: IdentifiableModelType, id: string): Promise<HistoryRecord[]> {
    await this.readable(packageId);
    return this.base.history(packageId, modelType, id);
  }

  // ── 사용자 — 작업 공간과 무관하다. 누가 계정을 다룰 수 있는지는 라우트(역할)가 정한다 ──
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
