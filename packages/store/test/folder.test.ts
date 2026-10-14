/**
 * Folder store tests.
 *
 * Checks two things:
 *  (1) Does it **behave exactly like** the in-memory and PostgreSQL stores — runs the same conformance suite
 *  (2) Does data **survive a restart** — the sole reason this store exists
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

describe('FolderStore — survives a restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('an uploaded file is still there after reopening', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: '롤포밍기.aasx', package: golden() });
    const before = await first.getEnvironment(record.id);

    // Equivalent to restarting the server — reread with a new instance
    const second = await open(dir);
    const list = await second.listPackages();
    expect(list.items.map((p) => p.name)).toEqual(['롤포밍기.aasx']);
    expect(await second.getEnvironment(record.id)).toEqual(before);
  });

  it('download is lossless — attachments and thumbnail survive too', async () => {
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

  it('edits and history persist', async () => {
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

  it('overlapping saves do not break — previously crashed with ENOENT from a shared temp file', async () => {
    const store = await open(dir);
    const record = await store.importPackage({ name: 'g.aasx', package: golden() });
    const submodels = await store.listIdentifiables(record.id, 'Submodel');
    const targets = submodels.items.slice(0, 5);

    // Five concurrent writes to one package — what happens when a UI save overlaps an auto-fix
    await Promise.all(
      targets.map((target, index) =>
        store.updateIdentifiable(record.id, 'Submodel', target.id, {
          ...target.content,
          idShort: `동시${index}`,
        }),
      ),
    );

    // Reopen and check **everything reached disk**. If only the last write survived, earlier ones were lost
    const again = await open(dir);
    for (const [index, target] of targets.entries()) {
      const after = await again.getIdentifiable(record.id, 'Submodel', target.id);
      expect(after?.content['idShort']).toBe(`동시${index}`);
    }
  });

  it('collected values accumulate and persist', async () => {
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

    // Values pruned by retention do not come back after reopening — because values.jsonl was rewritten
    expect(await second.pruneValues('2026-08-25T00:00:05.000Z')).toBe(1);
    const third = await open(dir);
    expect((await third.readValues(record.id)).map((v) => v.valueNumber)).toEqual([22]);
    // Pruning everything removes the file itself
    expect(await third.pruneValues('2027-01-01T00:00:00.000Z')).toBe(1);
    expect(await (await open(dir)).readValues(record.id)).toHaveLength(0);
  });

  it('a deleted package stays gone after reopening', async () => {
    const first = await open(dir);
    const record = await first.importPackage({ name: 'g.aasx', package: golden() });
    await first.deletePackage(record.id);

    const second = await open(dir);
    expect((await second.listPackages()).items).toEqual([]);
  });

  it('new package ids do not collide with existing ones', async () => {
    const first = await open(dir);
    const a = await first.importPackage({ name: 'a.aasx', package: golden() });

    const second = await open(dir);
    const b = await second.importPackage({ name: 'b.aasx', package: golden() });
    expect(b.id).not.toBe(a.id);
    expect((await second.listPackages()).items).toHaveLength(2);
  });
});

describe('FolderStore — accounts also survive a restart (user-reported, 2026-10-06)', () => {
  it('created admin, edits and deleted accounts are unchanged after reopening', async () => {
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
    // Important: if a new account inherited a deleted account's id, the audit trail's "who" would get mixed up
    const next = await second.createUser({ login: 'park', displayName: '박', role: 'editor', passwordHash: 'h' });
    expect(next.id).not.toBe(lee.id);
  });

  it('a stale id counter in the accounts file does not let a new account overwrite an existing one', async () => {
    // A counter behind the stored ids happens when users.json is restored from an older backup or edited by hand.
    // The ids already in the file are the backstop — the next id must come after the highest of them.
    const dir = freshDir();
    const stored = (id: string, login: string) => ({ id, login, displayName: login, role: 'editor', passwordHash: 'h', disabled: false, createdAt: '2026-10-01T00:00:00.000Z' });
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [stored('user_1', 'kim'), stored('user_2', 'lee')], nextUserId: 1 }), 'utf8');

    const store = await open(dir);
    const park = await store.createUser({ login: 'park', displayName: '박', role: 'viewer', passwordHash: 'h' });
    expect(park.id).toBe('user_3');
    expect((await store.findUserByLogin('kim'))?.id).toBe('user_1');
    expect(await store.countUsers()).toBe(3);
  });

  it('refuses to start when the accounts file is corrupt — starting with 0 accounts would let anyone become first admin', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'users.json'), '{ 깨진', 'utf8');
    await expect(open(dir)).rejects.toThrow(/users\.json/);
  });
});
