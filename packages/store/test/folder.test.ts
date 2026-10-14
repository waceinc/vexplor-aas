/**
 * Folder store tests.
 *
 * Checks two things:
 *  (1) Does it **behave exactly like** the in-memory and PostgreSQL stores — runs the same conformance suite
 *  (2) Does data **survive a restart** — the sole reason this store exists
 */
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { readAasx } from '@aas/aasx';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FolderStore, type StoredEvent } from '@aas/store';
import { voidedModelEvents } from '../src/folder-integration.js';
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
const golden = () => readAasx(new Uint8Array(readFileSync(`${fixtures}01-roll-forming-machine.aasx`)));

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
    expect(again.thumbnail?.part).toBe(exported.thumbnail?.part);
    expect(again.thumbnail?.data).toEqual(exported.thumbnail?.data);
    expect(again.supplementaryFiles.map((f) => f.part).sort()).toEqual(
      exported.supplementaryFiles.map((f) => f.part).sort(),
    );
    for (const file of exported.supplementaryFiles) {
      const match = again.supplementaryFiles.find((f) => f.part === file.part);
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

  it('an accounts file without a counter does not hand out "user_NaN"', async () => {
    const dir = freshDir();
    const stored = (id: string, login: string) => ({ id, login, displayName: login, role: 'editor', passwordHash: 'h', disabled: false, createdAt: '2026-10-01T00:00:00.000Z' });
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [stored('user_4', 'kim')] }), 'utf8');

    const store = await open(dir);
    const park = await store.createUser({ login: 'park', displayName: 'Park', role: 'viewer', passwordHash: 'h' });
    expect(park.id).toBe('user_5');
  });

  it('refuses to start when the accounts file is corrupt — starting with 0 accounts would let anyone become first admin', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'users.json'), '{ 깨진', 'utf8');
    await expect(open(dir)).rejects.toThrow(/users\.json/);
  });
});

// ── Integration files (docs/design/integration-v1.md §3.5, §3.7 item 11) ──────────────────────────────────────

/** A rename that fails for the paths `failWhen` picks — the torn write of a crash between two files */
function failingRename(failWhen: (to: string) => boolean): { rename: (from: string, to: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rename: async (from, to) => {
      calls.push(`${basename(from)} -> ${basename(to)}`);
      if (failWhen(to)) throw new Error('simulated power loss');
      await fsRename(from, to);
    },
  };
}

const lines = (dir: string, name: string): string[] =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line !== '') : [];

describe('FolderStore — integration state survives a restart', () => {
  it('events, subscriptions with secrets, deliveries, configs, refs and runtime state come back; seq continues', async () => {
    const dir = freshDir();
    const first = await open(dir);
    const pkg = await first.importPackage({ name: 'g.aasx', package: golden(), owner: 'ws1' });
    await first.appendEvents([{ id: 'rt-1', type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:00.000Z', packageId: pkg.id, data: { state: 'run' } }]);
    const sub = await first.createSubscription({
      name: 'MES', kind: 'webhook', url: 'https://mes.example.com/hook', types: ['equipment.*'], packageIds: [], enabled: true,
      options: {}, secretHint: 'abcd', secrets: { keyId: 'k1', secretSealed: 'k1:sealed', previousSealed: 'k0:old', previousUntil: '2026-10-15T00:00:00.000Z' },
    });
    await first.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 2, eventId: 'rt-1' }, { subscriptionId: sub.id, eventSeq: 1, eventId: 'x' }], '2026-10-14T00:00:00.000Z');
    const [claimed] = await first.claimDeliveries('2026-10-14T00:00:00.000Z', 1, 60_000);
    await first.completeDelivery(claimed!.id, { outcome: 'dead', at: '2026-10-14T00:00:01.000Z', error: 'gone', statusCode: 410 });
    await first.putServerIntegrationConfig({ schema: 'vexplor.integration/1' });
    await first.putPackageIntegrationConfig(pkg.id, { alarms: [] });
    await first.putExternalRefs(pkg.id, { schema: 'vexplor.externalRefs/1', subjects: [{ subject: { kind: 'asset', globalAssetId: 'urn:g' }, refs: [{ system: 'sap', type: 'equipment', id: '1' }] }] });
    await first.putRuntimeState('dispatcher:cursor', 2);
    await first.putRuntimeState(`projector:${pkg.id}`, { digest: 'abc' }, pkg.id);
    await first.flush();
    const before = await first.readEvents({ after: 0, limit: 100, includeAudit: true });

    const second = await open(dir);
    const after = await second.readEvents({ after: 0, limit: 100, includeAudit: true });
    expect(after).toEqual(before);
    expect(await second.getSubscription(sub.id)).toEqual(await first.getSubscription(sub.id));
    expect(await second.listDeliveries(sub.id)).toEqual(await first.listDeliveries(sub.id));
    expect(await second.deliveryStats()).toEqual(await first.deliveryStats());
    expect(await second.getServerIntegrationConfig()).toEqual(await first.getServerIntegrationConfig());
    expect(await second.getPackageIntegrationConfig(pkg.id)).toEqual(await first.getPackageIntegrationConfig(pkg.id));
    expect(await second.findExternalRef('sap', 'equipment', '1')).toEqual([{ packageId: pkg.id, subject: 'asset|urn:g' }]);
    expect(await second.getRuntimeState('dispatcher:cursor')).toBe(2);
    expect(await second.getRuntimeState(`projector:${pkg.id}`)).toEqual({ digest: 'abc' });

    // Counters continue — a reused seq or delivery id would collide with what consumers already hold
    const [next] = await second.appendEvents([{ id: 'rt-2', type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:02.000Z', data: {} }]);
    expect(next!.seq).toBe(before.lastSeq + 1);
    await second.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 3, eventId: 'rt-2' }], '2026-10-14T00:00:02.000Z');
    const ids = (await second.listDeliveries(sub.id)).items.map((row) => Number(row.id));
    expect(new Set(ids).size).toBe(3);
  });

  it('a deleted package leaves no config, refs or state behind after a restart; its events stay', async () => {
    const dir = freshDir();
    const first = await open(dir);
    const pkg = await first.importPackage({ name: 'g.aasx', package: golden() });
    await first.putPackageIntegrationConfig(pkg.id, { a: 1 });
    await first.putRuntimeState('projector:x', 1, pkg.id);
    await first.deletePackage(pkg.id);
    await first.flush();

    const second = await open(dir);
    expect(await second.getPackageIntegrationConfig(pkg.id)).toBeUndefined();
    expect(await second.getRuntimeState('projector:x')).toBeUndefined();
    const types = (await second.readEvents({ after: 0, limit: 10 })).items.map((event) => event.type);
    expect(types).toEqual(['kr.vexplor.aas.model.package.created.v1', 'kr.vexplor.aas.model.package.deleted.v1']);
  });
});

describe('FolderStore — crash between the event line and the model file', () => {
  it('torn edit: the event of a change that never reached disk is voided and never returned; its seq is not reused', async () => {
    const dir = freshDir();
    const good = await open(dir);
    const pkg = await good.importPackage({ name: 'g.aasx', package: golden() });
    const target = (await good.listIdentifiables(pkg.id, 'Submodel')).items[0]!;

    const torn = failingRename((to) => to.endsWith('model.json'));
    const crashing = new FolderStore(dir, undefined, torn);
    await crashing.init();
    await expect(
      crashing.updateIdentifiable(pkg.id, 'Submodel', target.id, { ...target.content, idShort: 'NeverSaved' }),
    ).rejects.toThrow(/power loss/);
    const lost = (await crashing.readEvents({ after: 0, limit: 10 })).items.at(-1)!;
    expect(lost.type).toBe('kr.vexplor.aas.model.submodel.updated.v1');
    // The line reached the file before the model write failed — that is the window the protocol covers
    expect(lines(dir, 'events.jsonl').some((line) => line.includes(lost.id))).toBe(true);

    const restarted = await open(dir);
    expect((await restarted.getIdentifiable(pkg.id, 'Submodel', target.id))?.content['idShort']).toBe(target.idShort);
    const ids = (await restarted.readEvents({ after: 0, limit: 10 })).items.map((event) => event.id);
    expect(ids).not.toContain(lost.id);
    expect(lines(dir, 'events.jsonl')).toContain(JSON.stringify({ void: lost.id }));

    // One more restart: the void line is durable, and the voided seq is still counted — it was the highest one, and
    // a consumer may already hold it as its cursor
    const again = await open(dir);
    expect((await again.readEvents({ after: 0, limit: 10 })).items.map((event) => event.id)).not.toContain(lost.id);
    const [next] = await again.appendEvents([{ id: 'after-crash', type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:00.000Z', data: {} }]);
    expect(next!.seq).toBeGreaterThan(lost.seq);
  });

  it('torn import: the created event of a package whose model file never appeared is voided', async () => {
    const dir = freshDir();
    const torn = failingRename((to) => to.endsWith('model.json'));
    const crashing = new FolderStore(dir, undefined, torn);
    await crashing.init();
    await expect(crashing.importPackage({ name: 'g.aasx', package: golden() })).rejects.toThrow(/power loss/);

    const restarted = await open(dir);
    expect((await restarted.listPackages()).items).toEqual([]);
    expect((await restarted.readEvents({ after: 0, limit: 10 })).items).toEqual([]);
  });

  it('voidedModelEvents — deletion that did not complete, re-created ids, runtime events untouched', () => {
    const row = (seq: number, type: string, packageId: string, packageRevision?: number): StoredEvent => ({
      seq, id: `e${seq}`, type: `kr.vexplor.aas.${type}.v1`, time: 't', recordedAt: 't', packageId, data: {},
      ...(packageRevision === undefined ? {} : { packageRevision }),
    });
    const events = [
      row(1, 'model.package.created', 'p1', 1),
      row(2, 'model.submodel.updated', 'p1', 2),
      row(3, 'model.package.deleted', 'p1', 3), // p1 still on disk → the removal never happened
      row(4, 'model.package.created', 'p2', 1),
      row(5, 'model.package.deleted', 'p2', 2), // p2 gone → valid deletion
      row(6, 'model.package.created', 'p3', 1),
      row(7, 'model.submodel.updated', 'p3', 6),
      row(8, 'model.package.deleted', 'p3', 7), // p3 re-created afterwards → valid
      row(9, 'model.package.created', 'p3', 1),
      row(10, 'model.submodel.updated', 'p3', 2), // ahead of disk (rev 1) → void
      row(11, 'equipment.state.changed', 'p1', 99), // runtime rows are never judged here
      row(12, 'model.package.created', 'p4', 1), // p4 never reached disk → void
    ];
    const revisions: Record<string, number> = { p1: 2, p3: 1 };
    expect([...voidedModelEvents(events, (id) => revisions[id])].sort()).toEqual(['e10', 'e12', 'e3']);
  });
});

describe('FolderStore — integration file formats', () => {
  it('deliveries.jsonl is appended per change and compacted to one line per delivery at startup', async () => {
    const dir = freshDir();
    const store = await open(dir);
    const sub = await store.createSubscription({
      name: 'S', kind: 'webhook', url: 'https://x.example.com', types: ['*'], packageIds: [], enabled: true, options: {}, secretHint: 'aaaa',
      secrets: { keyId: 'k', secretSealed: 's' },
    });
    await store.enqueueDeliveries([1, 2, 3].map((n) => ({ subscriptionId: sub.id, eventSeq: n, eventId: `e${n}` })), '2026-10-14T00:00:00.000Z');
    const claimed = await store.claimDeliveries('2026-10-14T00:00:00.000Z', 3, 1000);
    for (const row of claimed) await store.completeDelivery(row.id, { outcome: 'succeeded', at: '2026-10-14T00:00:01.000Z' });
    expect(lines(dir, 'deliveries.jsonl')).toHaveLength(9);

    const reopened = await open(dir);
    expect(lines(dir, 'deliveries.jsonl')).toHaveLength(3);
    expect((await reopened.listDeliveries(sub.id)).items.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // Prune rewrites the file too
    expect(await reopened.pruneDeliveries('2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')).toBe(3);
    expect(lines(dir, 'deliveries.jsonl')).toHaveLength(0);
  });

  it('integration.json is written through a temp file and rename; nothing is left half-written', async () => {
    const dir = freshDir();
    const spy = failingRename(() => false);
    const store = new FolderStore(dir, undefined, spy);
    await store.init();
    await store.putServerIntegrationConfig({ schema: 'x' });
    expect(spy.calls).toContain('integration.json.tmp -> integration.json');
    expect(existsSync(join(dir, 'integration.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'integration.json'), 'utf8')).serverConfig.value).toEqual({ schema: 'x' });
  });

  it('a failed integration.json write leaves the previous file intact', async () => {
    const dir = freshDir();
    const first = await open(dir);
    await first.putServerIntegrationConfig({ v: 1 });
    const broken = new FolderStore(dir, undefined, failingRename((to) => to.endsWith('integration.json')));
    await broken.init();
    await expect(broken.putServerIntegrationConfig({ v: 2 })).rejects.toThrow(/power loss/);
    expect((await (await open(dir)).getServerIntegrationConfig())?.value).toEqual({ v: 1 });
  });

  it('runtime state is coalesced — many puts within a second become at most two file writes', async () => {
    const dir = freshDir();
    const spy = failingRename(() => false);
    const store = new FolderStore(dir, undefined, spy);
    await store.init();
    for (let n = 1; n <= 20; n++) await store.putRuntimeState('detector:cursor', n);
    await store.flush();
    const writes = spy.calls.filter((call) => call.endsWith('integration-state.json')).length;
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(writes).toBeLessThanOrEqual(2);
    expect(await (await open(dir)).getRuntimeState('detector:cursor')).toBe(20);
  });

  it('refuses to start when integration.json is corrupt — subscriptions and their secrets would silently vanish', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'integration.json'), '{ broken', 'utf8');
    await expect(open(dir)).rejects.toThrow(/integration\.json/);
  });

  it('a torn last line of events.jsonl is skipped, the rest loads', async () => {
    const dir = freshDir();
    const first = await open(dir);
    await first.appendEvents([{ id: 'ok', type: 'kr.vexplor.aas.equipment.state.changed.v1', time: '2026-10-14T00:00:00.000Z', data: {} }]);
    appendFileSync(join(dir, 'events.jsonl'), '{"seq":2,"id":"half', 'utf8');
    const second = await open(dir);
    expect((await second.readEvents({ after: 0, limit: 10 })).items.map((event) => event.id)).toEqual(['ok']);
  });
});
