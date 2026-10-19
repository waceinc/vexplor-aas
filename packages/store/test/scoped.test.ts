/**
 * Workspace layer (scoped.ts) — "through whose eyes is the store viewed".
 *
 * Important: the one guarantee here is that **another user's files never leak through any path**.
 *    Every read path and write path of the store is exercised once — a single open path is a leak.
 */
import { readAasx } from '@aas/aasx';
import {
  ExternalRefConflictError,
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

  it('a value batch that touches another workspace file stores nothing, not even its own part (2.8.1)', async () => {
    const bobFile = await runInWorkspace(BOB, async () => (await store.importPackage({ name: '밥.aasx', package: golden() })).id);
    const value = (packageId: string) => ({ packageId, interfaceName: 'I', propertyName: 'P', observedAt: '2026-08-24T00:00:00.000Z', valueNumber: 1 });
    await runInWorkspace(BOB, async () => {
      await expect(
        store.appendValueBatch!([
          { packageId: bobFile, values: [value(bobFile)] },
          { packageId: aliceFile, values: [value(aliceFile)] },
        ]),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await store.readValues(bobFile)).toEqual([]);
      await store.appendValueBatch!([{ packageId: bobFile, values: [value(bobFile)] }]);
      expect(await store.readValues(bobFile)).toHaveLength(1);
    });
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
    // Alice's request is still running when Bob's finishes — guaranteed by a gate, not by a delay
    let bobDone!: () => void;
    const bobFinished = new Promise<void>((resolve) => (bobDone = resolve));
    const slow = runInWorkspace(ALICE, async () => {
      await bobFinished;
      return (await store.listPackages()).items.map((item) => item.id);
    });
    const fast = runInWorkspace(BOB, async () => {
      const ids = (await store.listPackages()).items.map((item) => item.id);
      bobDone();
      return ids;
    });
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

// ── Integration (docs/design/integration-v1.md §3.6, §3.7 item 13) ──────────────────────────────────────────────

describe('integration — events, subscriptions and state through workspace eyes', () => {
  const ev = (id: string, packageId?: string, type = 'kr.vexplor.aas.equipment.state.changed.v1') => ({
    id,
    type,
    time: '2026-10-14T00:00:00.000Z',
    data: {},
    ...(packageId === undefined ? {} : { packageId }),
  });
  let bobFile: string;
  const refs = (id: string) => ({
    schema: 'vexplor.externalRefs/1' as const,
    subjects: [{ subject: { kind: 'asset' as const, globalAssetId: `urn:g:${id}` }, refs: [{ system: 'sap', type: 'equipment', id }] }],
  });

  beforeEach(async () => {
    bobFile = await runInWorkspace(BOB, async () => (await store.importPackage({ name: 'bob.aasx', package: golden() })).id);
    // The server (no context) records runtime and audit events
    await store.appendEvents([ev('alice-rt', aliceFile), ev('bob-rt', bobFile), ev('server-audit', undefined, 'kr.vexplor.aas.integration.audit.v1')]);
  });

  it('a visitor reads own and shared events only — never another workspace, never audit rows', async () => {
    const seen = await runInWorkspace(BOB, async () =>
      // Asking for audit rows and passing someone else's key are both ignored
      (await store.readEvents({ after: 0, limit: 100, includeAudit: true }, { owner: 'visitor:alice' })).items,
    );
    const ids = seen.map((event) => event.id);
    expect(ids).toContain('bob-rt');
    expect(ids).not.toContain('alice-rt');
    expect(ids).not.toContain('server-audit');
    expect(seen.every((event) => event.owner === undefined || event.owner === 'visitor:bob')).toBe(true);
    // Shared package events (the template loaded without context) are visible
    expect(seen.some((event) => event.packageId === sharedFile)).toBe(true);
    expect(seen.some((event) => event.packageId === aliceFile)).toBe(false);
  });

  it('admin and the server see every event, audit included when asked', async () => {
    for (const run of [<T>(fn: () => T) => runInWorkspace(ADMIN, fn), <T>(fn: () => T) => fn()]) {
      const ids = await run(async () => (await store.readEvents({ after: 0, limit: 100, includeAudit: true })).items.map((event) => event.id));
      expect(ids).toEqual(expect.arrayContaining(['alice-rt', 'bob-rt', 'server-audit']));
    }
  });

  it('a visitor cannot touch the event log, subscriptions, deliveries, runtime state or the server config', async () => {
    await runInWorkspace(BOB, async () => {
      const refused: (() => unknown)[] = [
        () => store.appendEvents([ev('x')]),
        () => store.pruneEvents('2030-01-01T00:00:00.000Z'),
        () => store.listSubscriptions(),
        () => store.getSubscription('sub_1'),
        () => store.createSubscription({ name: 'n', kind: 'webhook', url: 'https://x', types: ['*'], packageIds: [], enabled: true, options: {}, secretHint: 'a', secrets: { keyId: 'k', secretSealed: 's' } }),
        () => store.updateSubscription('sub_1', { enabled: false }),
        () => store.deleteSubscription('sub_1'),
        () => store.enqueueDeliveries([], '2026-10-14T00:00:00.000Z'),
        () => store.claimDeliveries('2026-10-14T00:00:00.000Z', 1, 1000),
        () => store.completeDelivery('1', { outcome: 'succeeded', at: '2026-10-14T00:00:00.000Z' }),
        () => store.getDelivery('1'),
        () => store.listDeliveries('sub_1'),
        () => store.redeliver('1', '2026-10-14T00:00:00.000Z'),
        () => store.deliveryStats(),
        () => store.pruneDeliveries('2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
        () => store.getRuntimeState('dispatcher:cursor'),
        () => store.putRuntimeState('dispatcher:cursor', 1),
        () => store.putServerIntegrationConfig({}),
      ];
      for (const call of refused) expect(call).toThrow(ForbiddenError);
      // Reading the server config is allowed — every workspace's screens use the state rules
      expect(await store.getServerIntegrationConfig()).toBeUndefined();
    });
    // Nothing was written by the refused calls
    expect((await store.readEvents({ after: 0, limit: 100 })).items.map((event) => event.id)).not.toContain('x');
    // Admin is allowed
    await runInWorkspace(ADMIN, async () => {
      expect(await store.listSubscriptions()).toEqual([]);
      await store.putRuntimeState('dispatcher:cursor', 1);
    });
  });

  it('package config and refs follow the package: own read/write, shared read-only, others not found', async () => {
    await runInWorkspace(BOB, async () => {
      await store.putPackageIntegrationConfig(bobFile, { mine: true });
      expect((await store.getPackageIntegrationConfig(bobFile))?.value).toEqual({ mine: true });
      await store.putExternalRefs(bobFile, refs('B-1'));
      expect((await store.getExternalRefs(bobFile))?.revision).toBe(1);

      expect(await store.getPackageIntegrationConfig(sharedFile)).toBeUndefined();
      await expect(store.putPackageIntegrationConfig(sharedFile, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(store.putExternalRefs(sharedFile, refs('S-1'))).rejects.toBeInstanceOf(ForbiddenError);

      await expect(store.getPackageIntegrationConfig(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.putPackageIntegrationConfig(aliceFile, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.getExternalRefs(aliceFile)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.putExternalRefs(aliceFile, refs('A-9'))).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('ref lookups see keys held elsewhere but masked; a conflict with another workspace does not name its file', async () => {
    await runInWorkspace(ALICE, () => store.putExternalRefs(aliceFile, refs('A-1')));
    await runInWorkspace(BOB, async () => {
      // An import dry run must learn that the key is taken — but not by which file or asset
      const holders = await store.findExternalRef('sap', 'equipment', 'A-1');
      expect(holders).toHaveLength(1);
      expect(holders[0]!.packageId).not.toBe(aliceFile);
      expect(holders[0]!.subject).toBe('');
      expect((await store.listExternalRefs()).map((entry) => entry.packageId)).not.toContain(aliceFile);
      const error = await store.putExternalRefs(bobFile, refs('A-1')).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExternalRefConflictError);
      const claims = (error as ExternalRefConflictError).claims;
      expect(claims[1]).toMatchObject({ packageId: bobFile, subject: 'asset|urn:g:A-1' });
      expect(JSON.stringify(claims)).not.toContain(aliceFile);
      expect((error as Error).message).not.toContain(aliceFile);
    });
    // The owner and admin see the claim as it is
    expect(await runInWorkspace(ALICE, () => store.findExternalRef('sap', 'equipment', 'A-1'))).toEqual([{ packageId: aliceFile, subject: 'asset|urn:g:A-1' }]);
    const adminError = await runInWorkspace(ADMIN, () => store.putExternalRefs(bobFile, refs('A-1')).catch((caught: unknown) => caught));
    expect((adminError as ExternalRefConflictError).claims[0]?.packageId).toBe(aliceFile);
  });
});

describe('integration — review fixes (H1 orphan events, M4 batch)', () => {
  const ev = (id: string, packageId: string, owner?: string | null) => ({
    id,
    type: 'kr.vexplor.aas.equipment.master.changed.v1',
    time: '2026-10-14T00:00:00.000Z',
    packageId,
    data: { serialNumber: 'SN-SECRET' },
    ...(owner === undefined ? {} : { owner }),
  });
  const refs = (gid: string, id: string) => ({
    schema: 'vexplor.externalRefs/1' as const,
    subjects: [{ subject: { kind: 'asset' as const, globalAssetId: gid }, refs: [{ system: 'sap', type: 'equipment', id }] }],
  });

  it('events appended after a private package is deleted stay invisible to other workspaces (projector "removed")', async () => {
    await runInWorkspace(ALICE, () => store.deletePackage(aliceFile));
    // The server appends without knowing the owner any more — the package row is gone
    await store.appendEvents([ev('removed-after-delete', aliceFile)]);
    const bobSees = await runInWorkspace(BOB, async () => (await store.readEvents({ after: 0, limit: 1000 })).items.map((e) => e.id));
    expect(bobSees).not.toContain('removed-after-delete');
    // Admins and the server still see it
    const adminSees = await runInWorkspace(ADMIN, async () => (await store.readEvents({ after: 0, limit: 1000 })).items.map((e) => e.id));
    expect(adminSees).toContain('removed-after-delete');
  });

  it('an explicit owner on an appended event decides who sees it — null means shared', async () => {
    await runInWorkspace(ALICE, () => store.deletePackage(aliceFile));
    await store.appendEvents([ev('to-alice', aliceFile, 'visitor:alice'), ev('to-all', aliceFile, null)]);
    const seen = async (ws: typeof ALICE) =>
      runInWorkspace(ws, async () => (await store.readEvents({ after: 0, limit: 1000 })).items.map((e) => e.id));
    expect(await seen(ALICE)).toEqual(expect.arrayContaining(['to-alice', 'to-all']));
    expect(await seen(BOB)).toContain('to-all');
    expect(await seen(BOB)).not.toContain('to-alice');
  });

  it('putExternalRefsBatch checks every package is writable before writing and masks foreign conflicts', async () => {
    const bobFile = await runInWorkspace(BOB, async () => (await store.importPackage({ name: 'bob.aasx', package: golden() })).id);
    await runInWorkspace(ALICE, () => store.putExternalRefs(aliceFile, refs('urn:a', 'A-1')));
    await runInWorkspace(BOB, async () => {
      await expect(store.putExternalRefsBatch([{ packageId: bobFile, doc: refs('urn:b', 'B-1') }, { packageId: aliceFile, doc: refs('urn:a', 'X') }])).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.putExternalRefsBatch([{ packageId: bobFile, doc: refs('urn:b', 'B-1') }, { packageId: sharedFile, doc: refs('urn:s', 'S') }])).rejects.toBeInstanceOf(ForbiddenError);
      expect(await store.getExternalRefs(bobFile)).toBeUndefined();
      const error = await store.putExternalRefsBatch([{ packageId: bobFile, doc: refs('urn:b', 'A-1') }]).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExternalRefConflictError);
      expect(JSON.stringify((error as ExternalRefConflictError).claims)).not.toContain(aliceFile);
      expect(JSON.stringify((error as ExternalRefConflictError).claims)).not.toContain('urn:a');
      expect((await store.putExternalRefsBatch([{ packageId: bobFile, doc: refs('urn:b', 'B-1'), expectedRevision: 0 }]))[0]!.revision).toBe(1);
    });
  });
});

