/**
 * 폴더 보관함 검증.
 *
 * 두 가지를 본다.
 *  ① 메모리·PostgreSQL과 **똑같이 동작하는가** — 같은 적합성 테스트를 그대로 돌린다
 *  ② **껐다 켜도 남는가** — 이게 이 보관함을 만든 유일한 이유다
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAasx } from '@aas/aasx';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FolderStore } from '@aas/store';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { describeStore, describeStoreFilters } from './conformance.js';

const temps: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aas-folder-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function open(dir: string): Promise<FolderStore> {
  const store = new FolderStore(dir);
  await store.init();
  return store;
}

describeStore('FolderStore', async () => open(freshDir()));
describeStoreFilters('FolderStore', async () => open(freshDir()));

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const golden = () => readAasx(new Uint8Array(readFileSync(`${fixtures}01-롤포밍기-공34.aasx`)));

describe('FolderStore — 껐다 켜도 남는다', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('올린 파일이 다시 열었을 때 그대로 있다', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: '롤포밍기.aasx', package: golden() });
    const before = await first.getEnvironment(record.id);

    // 서버를 껐다 켠 셈이다 — 새 객체로 다시 읽는다
    const second = await open(dir);
    const list = await second.listPackages();
    expect(list.items.map((p) => p.name)).toEqual(['롤포밍기.aasx']);
    expect(await second.getEnvironment(record.id)).toEqual(before);
  });

  it('내려받기가 무손실이다 — 첨부와 썸네일까지 남는다', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: 'g.aasx', package: golden() });
    const exported = await first.exportPackage(record.id);

    const second = await open(dir);
    const again = await second.exportPackage(record.id);
    expect(again.specPart).toBe(exported.specPart);
    expect(again.thumbnail?.path).toBe(exported.thumbnail?.path);
    expect(again.thumbnail?.data).toEqual(exported.thumbnail?.data);
    expect(again.supplementaryFiles.map((f) => f.path).sort()).toEqual(
      exported.supplementaryFiles.map((f) => f.path).sort(),
    );
    for (const file of exported.supplementaryFiles) {
      const match = again.supplementaryFiles.find((f) => f.path === file.path);
      expect(match?.data).toEqual(file.data);
    }
    expect([...again.extraParts.keys()].sort()).toEqual([...exported.extraParts.keys()].sort());
  });

  it('고친 내용과 이력이 남는다', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: 'g.aasx', package: golden() });
    const submodels = await first.listIdentifiables(record.id, 'Submodel');
    const target = submodels.items[0]!;
    await first.updateIdentifiable(record.id, 'Submodel', target.id, {
      ...target.content,
      idShort: '바뀐이름',
    });

    const second = await open(dir);
    const after = await second.getIdentifiable(record.id, 'Submodel', target.id);
    expect(after?.content['idShort']).toBe('바뀐이름');
    expect(after?.revision).toBe(target.revision + 1);
    expect(await second.history(record.id, 'Submodel', target.id)).toHaveLength(1);
  });

  it('🔴 저장이 겹쳐도 깨지지 않는다 — 임시 파일을 공유해 ENOENT로 터지던 것', async () => {
    const store = await open(dir);
    const record = await store.importPackage({ name: 'g.aasx', package: golden() });
    const submodels = await store.listIdentifiables(record.id, 'Submodel');
    const targets = submodels.items.slice(0, 5);

    // 같은 패키지에 동시에 다섯 번 쓴다 — 화면에서 저장과 자동 고치기가 겹치는 모습이다
    await Promise.all(
      targets.map((target, index) =>
        store.updateIdentifiable(record.id, 'Submodel', target.id, {
          ...target.content,
          idShort: `동시${index}`,
        }),
      ),
    );

    // 다시 열어 **디스크에 전부 남았는지** 본다. 마지막 쓰기만 남으면 앞의 것을 잃은 것이다
    const again = await open(dir);
    for (const [index, target] of targets.entries()) {
      const after = await again.getIdentifiable(record.id, 'Submodel', target.id);
      expect(after?.content['idShort']).toBe(`동시${index}`);
    }
  });

  it('수집값이 쌓이고 남는다', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: 'g.aasx', package: golden() });
    await first.appendValues(record.id, [
      {
        packageId: record.id,
        observedAt: '2026-08-25T00:00:00.000Z',
        interfaceName: 'PLC',
        propertyName: '온도',
        valueNumber: 21,
      },
      {
        packageId: record.id,
        observedAt: '2026-08-25T00:00:05.000Z',
        interfaceName: 'PLC',
        propertyName: '온도',
        valueNumber: 22,
      },
    ]);

    const second = await open(dir);
    const values = await second.readValues(record.id);
    expect(values).toHaveLength(2);
    expect(values.map((v) => v.valueNumber).sort()).toEqual([21, 22]);

    // 보존 기간으로 지운 것은 다시 열어도 돌아오지 않는다 — values.jsonl을 다시 썼기 때문
    expect(await second.pruneValues('2026-08-25T00:00:05.000Z')).toBe(1);
    const third = await open(dir);
    expect((await third.readValues(record.id)).map((v) => v.valueNumber)).toEqual([22]);
    // 다 지우면 파일 자체가 없어진다
    expect(await third.pruneValues('2027-01-01T00:00:00.000Z')).toBe(1);
    expect(await (await open(dir)).readValues(record.id)).toHaveLength(0);
  });

  it('지운 패키지는 다시 열어도 없다', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: 'g.aasx', package: golden() });
    await first.deletePackage(record.id);

    const second = await open(dir);
    expect((await second.listPackages()).items).toEqual([]);
  });

  it('새 패키지 번호가 기존 것과 부딪히지 않는다', async () => {
    const first = await open(dir);
    const a = await first.importPackage({ name: 'a.aasx', package: golden() });

    const second = await open(dir);
    const b = await second.importPackage({ name: 'b.aasx', package: golden() });
    expect(b.id).not.toBe(a.id);
    expect((await second.listPackages()).items).toHaveLength(2);
  });
});

describe('FolderStore — 계정도 껐다 켜도 남는다 (2026-10-06 사용자 실측)', () => {
  it('만든 관리자·고친 내용·지운 계정이 다시 열어도 그대로다', async () => {
    const dir = freshDir();
    const first = await open(dir);
    const admin = await first.createUser({ login: 'Admin', displayName: '관리자', role: 'admin', passwordHash: 'scrypt$x' });
    const kim = await first.createUser({ login: 'kim', displayName: '김', role: 'editor', passwordHash: 'scrypt$y' });
    await first.updateUser(kim.id, { disabled: true });
    const lee = await first.createUser({ login: 'lee', displayName: '이', role: 'viewer', passwordHash: 'scrypt$z' });
    await first.deleteUser(lee.id);
    await first.touchUserLogin(admin.id);

    const second = await open(dir);
    expect(await second.countUsers()).toBe(2);
    expect((await second.findUserByLogin('admin'))?.role).toBe('admin');
    expect((await second.findUserByLogin('admin'))?.lastLoginAt).toBeDefined();
    expect((await second.getUser(kim.id))?.disabled).toBe(true);
    expect(await second.findUserByLogin('lee')).toBeUndefined();
    // 🔴 지운 계정의 번호를 새 계정이 물려받으면 감사 기록의 「누가」가 섞인다
    const next = await second.createUser({ login: 'park', displayName: '박', role: 'editor', passwordHash: 'h' });
    expect(next.id).not.toBe(lee.id);
  });

  it('계정 파일이 깨졌으면 기동을 멈춘다 — 계정 0개로 뜨면 아무나 첫 관리자가 된다', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'users.json'), '{ 깨진', 'utf8');
    await expect(open(dir)).rejects.toThrow(/users\.json/);
  });
});
