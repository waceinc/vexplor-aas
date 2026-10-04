/**
 * 폴더 보관함 — 내 컴퓨터의 폴더에 파일로 남긴다.
 *
 * 만든 이유는 하나다. **Docker를 없애기 위해서다.**
 * 지금까지 보관함은 둘뿐이었다 — 메모리(끄면 사라짐)와 PostgreSQL(Docker 필요).
 * 혼자 쓰는 사람에게 "파일이 남게 하려면 데이터베이스를 띄우십시오"는 과하다.
 * 실제로 설치가 어렵다는 이야기가 여기서 나왔다(2026-08-25 사용자).
 *
 * 설계는 단순하다. **InMemoryStore를 그대로 쓰고, 바뀔 때마다 폴더에 적는다.**
 * 자료구조를 새로 짜지 않으니 두 보관함의 동작이 갈릴 여지가 없다 —
 * 같은 적합성 테스트(test/conformance.ts)를 그대로 돌린다.
 *
 * 폴더 모양:
 *
 *   <데이터폴더>/
 *     pkg_1/model.json      패키지·요소·첨부·이력 (바뀔 때마다 통째로 다시 씀)
 *     pkg_1/values.jsonl    수집값 (한 줄에 하나씩 덧붙임)
 *     users.json            계정 (비밀번호는 해시만) — 바뀔 때마다 통째로 다시 씀
 *
 * 🔴 계정을 빠뜨렸던 적이 있다(2026-10-06 사용자 실측). 패키지만 적고 계정은 메모리에만 두어,
 *    관리자를 만들고 서버를 껐다 켜면 계정이 사라지고 「첫 관리자 만들기」로 돌아갔다.
 *    그 사이 서버가 **보호 모드도 아닌 채로** 비어 있게 되므로 보안 문제이기도 하다.
 *
 * 🔴 수집값을 model.json에 같이 넣지 않는 이유: 수집은 몇 초마다 돈다.
 *    그때마다 첨부까지 든 수 MB짜리 파일을 다시 쓰면 디스크가 갈린다. 덧붙이기로 나눴다.
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

  /** 폴더를 읽어 들인다. 폴더가 없으면 만든다 */
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
        // 🔴 한 패키지가 깨졌다고 나머지까지 못 열면 안 된다. 그것만 건너뛴다.
        //    (지우지도 않는다 — 사용자가 직접 보고 판단할 수 있어야 한다)
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
      return; // 아직 계정이 없다
    }
    // 🔴 깨졌으면 **기동을 멈춘다.** 건너뛰면 계정 0개로 떠서 아무나 「첫 관리자」가 될 수 있다
    let snapshot: UserSnapshot;
    try {
      snapshot = JSON.parse(text) as UserSnapshot;
    } catch (error) {
      throw new Error(`${join(this.dir, USERS_FILE)}을(를) 읽지 못했습니다 — 손으로 고치거나 지운 뒤 다시 띄우십시오: ${String(error)}`);
    }
    this.restoreUsers(snapshot);
  }

  /** 계정 쓰기도 한 줄로 세운다 — 패키지와 같은 이유(같은 .tmp를 둘이 쓰면 깨진다) */
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
        // 쓰다가 전원이 나가면 마지막 줄이 잘린다. 그 줄만 버린다
      }
    }
    return values;
  }

  /**
   * 🔴 통째로 다시 쓸 때는 **임시 파일에 쓰고 이름을 바꾼다.**
   * 그냥 덮어쓰다가 전원이 나가면 반쯤 쓰인 파일이 남아 다음에 못 연다.
   */
  /**
   * 패키지별 「쓰기 차례」 — 같은 패키지에 쓰는 일을 **한 줄로 세운다**.
   *
   * 🔴 없으면 깨진다(2026-10-02 실측). 같은 패키지에 저장이 둘 겹치면 둘 다 같은
   *    `model.json.tmp`에 쓰고, 먼저 끝난 쪽이 그것을 rename으로 가져가 버려서
   *    나중 쪽이 `ENOENT`로 터진다. 운이 나쁘면 터지지 않고 **반쯤 섞인 내용**이
   *    model.json이 된다 — 조용히 잃는 쪽이 훨씬 나쁘다.
   *    화면에서 저장과 자동 고치기가 겹치거나 창을 두 개 띄우면 바로 나는 일이다.
   */
  private readonly writes = new Map<string, Promise<void>>();

  private async persist(packageId: string): Promise<void> {
    // 앞 쓰기가 끝난 **뒤에** 찍는다 — 그래야 나중 쓰기가 항상 더 새 내용을 담는다
    const previous = this.writes.get(packageId) ?? Promise.resolve();
    const next = previous
      // 앞의 실패가 뒤를 막으면 한 번 고장 난 패키지가 영영 저장되지 않는다
      .catch(() => undefined)
      .then(() => this.writeModel(packageId));
    this.writes.set(packageId, next);
    try {
      await next;
    } finally {
      // 마지막 차례였으면 지운다 — 끝난 약속을 계속 들고 있을 이유가 없다
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

  // ── 아래는 전부 "원래대로 하고, 폴더에 적는다" ─────────────────────────────

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
    // 남은 것으로 values.jsonl을 통째로 다시 쓴다 — 지운 흔적을 파일에도 남기지 않는다
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
      // readValues는 최근 것이 앞이다 — 파일은 쌓인 순서(오래된 것 먼저)를 유지한다
      const lines = [...kept].reverse().map((value) => JSON.stringify(value)).join('\n');
      await writeFile(path, `${lines}\n`, 'utf8');
    }
  }
}
