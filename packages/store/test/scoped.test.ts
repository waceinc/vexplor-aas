/**
 * Workspace layer (scoped.ts) — "through whose eyes is the store viewed".
 *
 * Important: the one guarantee here is that **another user's files never leak through any path**.
 *    Every read path and write path of the store is exercised once — a single open path is a leak.
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
const golden = () => readAasx(new Uint8Array(readFileSync(`${fixtures}01-roll-forming-machine.aasx`)));

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
  // Uploaded without context = a template the server loaded at startup; it has no owner
  sharedFile = (await store.importPackage({ name: '템플릿.aasx', package: golden() })).id;
  aliceFile = await runInWorkspace(ALICE, async () => (await store.importPackage({ name: '앨리스.aasx', package: golden() })).id);
  submodelId = golden().environment.submodels![0]!.id;
});

describe('belongs to the uploader', () => {
  it('uploading inside a workspace records its key as owner', async () => {
    const record = await runInWorkspace(ALICE, () => store.getPackage(aliceFile));
    expect(record?.owner).toBe('visitor:alice');
  });

  it('uploads without context are shared — server-loaded templates', async () => {
    expect((await store.getPackage(sharedFile))?.owner).toBeUndefined();
  });
});

describe('files of others look as if they do not exist', () => {
  it('they do not appear in the list', async () => {
    const seen = await runInWorkspace(BOB, async () => (await store.listPackages()).items.map((item) => item.id));
    expect(seen).not.toContain(aliceFile);
    expect(seen).toContain(sharedFile);
  });

  it('passing someone else\'s key does not help — the layer decides the scope', async () => {
    const seen = await runInWorkspace(BOB, async () =>
      (await store.listPackages({}, { owner: 'visitor:alice' })).items.map((item) => item.id),
    );
    expect(seen).not.toContain(aliceFile);
  });

  it('all eight read paths answer "not found"', async () => {
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

  it('all seven write paths also answer "not found" — not 403', async () => {
    // A 403 would reveal "it does exist"; probing ids would expose whether someone else's file exists
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
    // And nothing actually changed
    const still = await runInWorkspace(ALICE, () => store.getIdentifiable(aliceFile, 'Submodel', submodelId));
    expect(still).toBeDefined();
  });

  it('gives **the same answer** as a truly missing one — any difference leaks existence', async () => {
    const [hidden, missing] = await runInWorkspace(BOB, async () => [
      await store.exportPackage(aliceFile).catch((error: Error) => error),
      await store.exportPackage('pkg_없음').catch((error: Error) => error),
    ]);
    expect(hidden).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((hidden as Error).constructor).toBe((missing as Error).constructor);
  });
});

describe('ownerless (shared) items are read-only', () => {
  it('anyone can read them — the source for "import from another file"', async () => {
    await runInWorkspace(BOB, async () => {
      expect(await store.getPackage(sharedFile)).toBeDefined();
      expect((await store.exportPackage(sharedFile)).environment.submodels!.length).toBeGreaterThan(0);
    });
  });

  it('but cannot modify them — one visitor deleting a template would lose it for everyone', async () => {
    await runInWorkspace(BOB, async () => {
      await expect(store.deletePackage(sharedFile)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        store.updateIdentifiable(sharedFile, 'Submodel', submodelId, { modelType: 'Submodel', id: submodelId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
    expect(await store.getPackage(sharedFile)).toBeDefined();
  });
});

describe('my own files work as usual', () => {
  it('read, update, delete', async () => {
    await runInWorkspace(ALICE, async () => {
      const current = (await store.getIdentifiable(aliceFile, 'Submodel', submodelId))!;
      await store.updateIdentifiable(aliceFile, 'Submodel', submodelId, { ...current.content, idShort: '고침' });
      expect((await store.getIdentifiable(aliceFile, 'Submodel', submodelId))?.idShort).toBe('고침');
      await store.deletePackage(aliceFile);
      expect(await store.getPackage(aliceFile)).toBeUndefined();
    });
  });
});

describe('see-all scope — admin and API key', () => {
  it('sees and edits files of others — operations require it', async () => {
    await runInWorkspace(ADMIN, async () => {
      const seen = (await store.listPackages()).items.map((item) => item.id);
      expect(seen).toContain(aliceFile);
      expect(seen).toContain(sharedFile);
      await store.deletePackage(sharedFile);
    });
  });

  it('replacing someone else\'s file wholesale keeps its owner', async () => {
    await runInWorkspace(ADMIN, async () => {
      const existing = (await store.getPackage(aliceFile))!;
      await store.deletePackage(aliceFile);
      // Exactly what the route does — pass along the original owner
      await store.importPackage({ id: aliceFile, name: '바꿈.aasx', package: golden(), owner: existing.owner ?? null });
    });
    const record = await runInWorkspace(ALICE, () => store.getPackage(aliceFile));
    expect(record?.owner).toBe('visitor:alice');
  });
});

describe('without context everything is visible — the server itself, and servers without workspaces', () => {
  it('periodic collection and cleanup handle every package', async () => {
    const seen = (await store.listPackages()).items.map((item) => item.id);
    expect(seen).toContain(aliceFile);
    expect(seen).toContain(sharedFile);
    await store.appendValues(aliceFile, []);
  });

  it('a visitor request cannot prune collected values of others', async () => {
    await runInWorkspace(BOB, async () => {
      expect(() => store.pruneValues(new Date().toISOString())).toThrow(ForbiddenError);
    });
    // The server itself can
    expect(await store.pruneValues(new Date(0).toISOString())).toBe(0);
  });

  it('overlapping requests do not see each other\'s workspace', async () => {
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

describe('serving precollected data — visibleInWorkspace', () => {
  // Data that bypasses the store (e.g. past periodic-collection results) cannot be filtered by the layer
  it('everything is visible without context', () => {
    expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(true);
    expect(visibleInWorkspace(undefined)).toBe(true);
  });

  it('within a context, only mine and shared', () => {
    runInWorkspace(BOB, () => {
      expect(visibleInWorkspace({ owner: 'visitor:bob' })).toBe(true);
      expect(visibleInWorkspace({})).toBe(true);
      expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(false);
      // Results of already-deleted packages are not served either — their owner is unknown
      expect(visibleInWorkspace(undefined)).toBe(false);
    });
    runInWorkspace(ADMIN, () => {
      expect(visibleInWorkspace({ owner: 'visitor:alice' })).toBe(true);
    });
  });
});
