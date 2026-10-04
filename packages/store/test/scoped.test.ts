/**
 * 작업 공간 겹(scoped.ts) — 「누구의 눈으로 저장소를 보는가」.
 *
 * 🔴 여기서 지키는 것은 **남의 파일이 어떤 길로도 새지 않는다**는 것 하나다.
 *    저장소의 읽는 길·쓰는 길을 전부 한 번씩 밟아 본다 — 한 군데만 열려 있어도 샌다.
 */
import { readAasx } from '@aas/aasx';
import {
  ForbiddenError,
  InMemoryStore,
  NotFoundError,
  runInWorkspace,
  scopeStore,
  visibleInWorkspace,
  type AasStore,
  type Workspace,
} from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = () => readAasx(new Uint8Array(readFileSync(`${fixtures}01-롤포밍기-공34.aasx`)));

const ALICE: Workspace = { key: 'visitor:alice', seesAll: false };
const BOB: Workspace = { key: 'visitor:bob', seesAll: false };
const ADMIN: Workspace = { key: 'user:admin', seesAll: true };

let store: AasStore;
let aliceFile: string;
let sharedFile: string;
let submodelId: string;

beforeEach(async () => {
  const base = new InMemoryStore();
  await base.init();
  store = scopeStore(base);
  // 문맥 없이 올린 것 = 서버가 기동 때 올린 템플릿. 주인이 없다
  sharedFile = (await store.importPackage({ name: '템플릿.aasx', package: golden() })).id;
  aliceFile = await runInWorkspace(ALICE, async () => (await store.importPackage({ name: '앨리스.aasx', package: golden() })).id);
  submodelId = golden().environment.submodels![0]!.id;
});

describe('올린 사람의 것이 된다', () => {
  it('작업 공간 안에서 올리면 그 열쇠가 주인으로 적힌다', async () => {
    const record = await runInWorkspace(ALICE, () => store.getPackage(aliceFile));
    expect(record?.owner).toBe('visitor:alice');
  });

  it('문맥 없이 올린 것은 공용이다 — 서버가 올린 템플릿', async () => {
    expect((await store.getPackage(sharedFile))?.owner).toBeUndefined();
  });
});

describe('🔴 남의 것은 없는 것처럼 보인다', () => {
  it('목록에 안 나온다', async () => {
    const seen = await runInWorkspace(BOB, async () => (await store.listPackages()).items.map((item) => item.id));
    expect(seen).not.toContain(aliceFile);
    expect(seen).toContain(sharedFile);
  });

  it('🔴 부른 쪽이 남의 열쇠를 넘겨도 소용없다 — 범위는 겹이 정한다', async () => {
    const seen = await runInWorkspace(BOB, async () =>
      (await store.listPackages({}, { owner: 'visitor:alice' })).items.map((item) => item.id),
    );
    expect(seen).not.toContain(aliceFile);
  });

  it('읽는 길 여덟이 전부 「없다」고 답한다', async () => {
    await runInWorkspace(BOB, async () => {
      expect(await store.getPackage(aliceFile)).toBeUndefined();
      await expect(store.exportPackage(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.getEnvironment(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.packageFiles(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.listIdentifiables(aliceFile, 'Submodel')).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.getIdentifiable(aliceFile, 'Submodel', submodelId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.readValues(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.history(aliceFile, 'Submodel', submodelId)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('쓰는 길 일곱도 전부 「없다」고 답한다 — 403이 아니다', async () => {
    // 403이면 「있긴 있다」를 알려 주게 된다. id를 찍어 보며 남의 파일이 있는지 알아낼 수 있다
    await runInWorkspace(BOB, async () => {
      const file = { part: '/x.txt', role: 'extra' as const, contentType: 'text/plain', data: new Uint8Array([1]) };
      await expect(store.deletePackage(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.putPackageFile(aliceFile, file)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.deletePackageFile(aliceFile, '/x.txt')).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.createIdentifiable(aliceFile, { modelType: 'Submodel', id: 'urn:x' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        store.updateIdentifiable(aliceFile, 'Submodel', submodelId, { modelType: 'Submodel', id: submodelId }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.deleteIdentifiable(aliceFile, 'Submodel', submodelId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.appendValues(aliceFile, [])).rejects.toBeInstanceOf(NotFoundError);
    });
    // 그리고 실제로 아무 것도 안 바뀌었다
    const still = await runInWorkspace(ALICE, () => store.getIdentifiable(aliceFile, 'Submodel', submodelId));
    expect(still).toBeDefined();
  });

  it('진짜 없는 것과 **같은 답**이다 — 다르면 있는지 없는지가 샌다', async () => {
    const [hidden, missing] = await runInWorkspace(BOB, async () => [
      await store.exportPackage(aliceFile).catch((error: Error) => error),
      await store.exportPackage('pkg_없음').catch((error: Error) => error),
    ]);
    expect(hidden).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((hidden as Error).constructor).toBe((missing as Error).constructor);
  });
});

describe('주인 없는 것(공용)은 읽기만', () => {
  it('누구나 읽는다 — 「다른 파일에서 가져오기」의 출처다', async () => {
    await runInWorkspace(BOB, async () => {
      expect(await store.getPackage(sharedFile)).toBeDefined();
      expect((await store.exportPackage(sharedFile)).environment.submodels!.length).toBeGreaterThan(0);
    });
  });

  it('🔴 고치지는 못한다 — 방문자 하나가 템플릿을 지우면 모두가 잃는다', async () => {
    await runInWorkspace(BOB, async () => {
      await expect(store.deletePackage(sharedFile)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        store.updateIdentifiable(sharedFile, 'Submodel', submodelId, { modelType: 'Submodel', id: submodelId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
    expect(await store.getPackage(sharedFile)).toBeDefined();
  });
});

describe('내 것은 평소대로', () => {
  it('읽고 고치고 지운다', async () => {
    await runInWorkspace(ALICE, async () => {
      const current = (await store.getIdentifiable(aliceFile, 'Submodel', submodelId))!;
      await store.updateIdentifiable(aliceFile, 'Submodel', submodelId, { ...current.content, idShort: '고침' });
      expect((await store.getIdentifiable(aliceFile, 'Submodel', submodelId))?.idShort).toBe('고침');
      await store.deletePackage(aliceFile);
      expect(await store.getPackage(aliceFile)).toBeUndefined();
    });
  });
});

describe('전부 보는 쪽 — 관리자 · API 키', () => {
  it('남의 것도 보고 고친다 — 운영하려면 봐야 한다', async () => {
    await runInWorkspace(ADMIN, async () => {
      const seen = (await store.listPackages()).items.map((item) => item.id);
      expect(seen).toContain(aliceFile);
      expect(seen).toContain(sharedFile);
      await store.deletePackage(sharedFile);
    });
  });

  it('🔴 남의 파일을 통째로 바꿔 줘도 주인이 안 바뀐다', async () => {
    await runInWorkspace(ADMIN, async () => {
      const existing = (await store.getPackage(aliceFile))!;
      await store.deletePackage(aliceFile);
      // 라우트가 하는 그대로 — 원래 주인을 넘긴다
      await store.importPackage({ id: aliceFile, name: '바꿈.aasx', package: golden(), owner: existing.owner ?? null });
    });
    const record = await runInWorkspace(ALICE, () => store.getPackage(aliceFile));
    expect(record?.owner).toBe('visitor:alice');
  });
});

describe('문맥이 없으면 전부 보인다 — 서버 자신과, 나누지 않는 서버', () => {
  it('주기 수집·정리가 모든 패키지를 다룬다', async () => {
    const seen = (await store.listPackages()).items.map((item) => item.id);
    expect(seen).toContain(aliceFile);
    expect(seen).toContain(sharedFile);
    await store.appendValues(aliceFile, []);
  });

  it('🔴 방문자의 요청이 남의 수집값까지 지우지 못한다', async () => {
    await runInWorkspace(BOB, async () => {
      expect(() => store.pruneValues(new Date().toISOString())).toThrow(ForbiddenError);
    });
    // 서버 자신은 한다
    expect(await store.pruneValues(new Date(0).toISOString())).toBe(0);
  });

  it('겹쳐 도는 요청이 서로의 작업 공간을 보지 않는다', async () => {
    const slow = runInWorkspace(ALICE, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return (await store.listPackages()).items.map((item) => item.id);
    });
    const fast = runInWorkspace(BOB, async () => (await store.listPackages()).items.map((item) => item.id));
    const [alice, bob] = await Promise.all([slow, fast]);
    expect(alice).toContain(aliceFile);
    expect(bob).not.toContain(aliceFile);
  });
});

describe('미리 모아 둔 것을 내줄 때 — visibleInWorkspace', () => {
  // 주기 수집의 지난 결과처럼 저장소를 거치지 않는 것은 겹이 걸러 주지 못한다
  it('문맥이 없으면 전부 보인다', () => {
    expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(true);
    expect(visibleInWorkspace(undefined)).toBe(true);
  });

  it('문맥 안에서는 내 것과 공용만', () => {
    runInWorkspace(BOB, () => {
      expect(visibleInWorkspace({ owner: 'visitor:bob' })).toBe(true);
      expect(visibleInWorkspace({})).toBe(true);
      expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(false);
      // 이미 사라진 패키지의 결과도 내주지 않는다 — 누구 것이었는지 알 수 없다
      expect(visibleInWorkspace(undefined)).toBe(false);
    });
    runInWorkspace(ADMIN, () => {
      expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(true);
    });
  });
});
