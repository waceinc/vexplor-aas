/**
 * Integration store conformance (docs/design/integration-v1.md §3.7 items 1–10) — called from `describeStore`, so the
 * memory, folder and PostgreSQL stores (PGlite, and real PostgreSQL when DATABASE_URL is set) run the same scenarios.
 *
 * Important: model events are compared with **exact** payload objects, not with a few spot checks. Consumers parse these
 *    bytes; a field that one store adds or names differently is a contract break even if every spot check passes.
 */
import type { AasxPackage } from '@aas/aasx';
import { EVENT_TYPES } from '@aas/core';
import {
  ConflictError,
  ExternalRefConflictError,
  NotFoundError,
  ORPHAN_OWNER,
  runAsActor,
  runWithChange,
  type AasStore,
  type ExternalRefsDoc,
  type NewEvent,
  type NewSubscription,
  type StoredEvent,
} from '@aas/store';
import { describe, expect, it } from 'vitest';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SM_SEMANTIC = 'urn:example:semantic:nameplate';

/** A package with one AAS and one submodel — small, so the expected payloads can be written out in full */
function tinyPackage(n: string): AasxPackage {
  return {
    environment: {
      assetAdministrationShells: [
        {
          modelType: 'AssetAdministrationShell',
          id: `urn:example:aas:${n}`,
          idShort: `Shell${n}`,
          assetInformation: { assetKind: 'Instance', globalAssetId: `urn:example:asset:${n}` },
        },
      ],
      submodels: [
        {
          modelType: 'Submodel',
          id: `urn:example:sm:${n}`,
          idShort: 'Nameplate',
          semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: SM_SEMANTIC }] },
        },
      ],
    },
    specPart: '/aasx/data.json',
    supplementaryFiles: [],
    extraParts: new Map(),
  } as never;
}

const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventsAfter(store: AasStore, after: number): Promise<StoredEvent[]> {
  return (await store.readEvents({ after, limit: 1000, includeAudit: true })).items;
}

async function lastSeq(store: AasStore): Promise<number> {
  return (await store.readEvents({ after: 0, limit: 1 })).lastSeq;
}

/** Runs `fn` and returns the events it produced — and asserts there is exactly one */
async function onlyEvent(store: AasStore, fn: () => Promise<unknown>): Promise<StoredEvent> {
  const before = await lastSeq(store);
  await fn();
  const produced = await eventsAfter(store, before);
  expect(produced.map((event) => event.type)).toHaveLength(1);
  return produced[0]!;
}

const subscription = (patch: Partial<NewSubscription> = {}): NewSubscription => ({
  name: 'MES',
  kind: 'webhook',
  url: 'https://mes.example.com/hook',
  types: ['equipment.*'],
  packageIds: [],
  enabled: true,
  options: { topicPrefix: 'plant/a' },
  secretHint: 'abcd',
  secrets: { keyId: 'k1', secretSealed: 'k1:c2VhbGVk/+=' },
  ...patch,
});

const ev = (id: string, patch: Partial<NewEvent> = {}): NewEvent => ({
  id,
  type: EVENT_TYPES.equipmentStateChanged,
  time: '2026-10-14T00:00:00.000Z',
  data: { n: id, nested: { list: [1, 'two', null] }, text: '한글 "quoted"' },
  ...patch,
});

const refsDoc = (globalAssetId: string, refs: { system: string; type: string; id: string }[]): ExternalRefsDoc => ({
  schema: 'vexplor.externalRefs/1',
  subjects: [{ subject: { kind: 'asset', globalAssetId }, refs }],
});

const T0 = '2026-10-14T00:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

export function describeStoreIntegration(name: string, create: () => Promise<AasStore>): void {
  describe(`${name} — integration conformance`, () => {
    async function fresh(): Promise<AasStore> {
      const store = await create();
      await store.init();
      return store;
    }

    async function withPackage(owner?: string): Promise<{ store: AasStore; packageId: string }> {
      const store = await fresh();
      const record = await store.importPackage({ name: 'tiny.aasx', package: tinyPackage('1'), ...(owner ? { owner } : {}) });
      return { store, packageId: record.id };
    }

    // ── 1 · model events ──

    describe('model events — one per mutating method, inside the change', () => {
      it('importPackage → model.package.created with owner, actor, change context and counts', async () => {
        const store = await fresh();
        let packageId = '';
        const event = await onlyEvent(store, () =>
          runAsActor({ id: 'user_7', name: 'Kim' }, () =>
            runWithChange({ cause: 'import', changeSetId: 'chg_1' }, async () => {
              packageId = (await store.importPackage({ name: 'tiny.aasx', package: tinyPackage('1'), owner: 'ws1' })).id;
            }),
          ),
        );
        expect(event).toMatchObject({
          type: EVENT_TYPES.modelPackageCreated,
          packageId,
          subject: `packages/${packageId}`,
          packageRevision: 1,
          owner: 'ws1',
          actorId: 'user_7',
          actorName: 'Kim',
          cause: 'import',
          changeSetId: 'chg_1',
        });
        expect(event.time).toMatch(ISO);
        expect(event.recordedAt).toMatch(ISO);
        expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(event.data).toEqual({
          packageId,
          name: 'tiny.aasx',
          owner: 'ws1',
          globalAssetId: 'urn:example:asset:1',
          aasId: 'urn:example:aas:1',
          counts: { AssetAdministrationShell: 1, Submodel: 1, ConceptDescription: 0 },
        });
      });

      it('no actor and no change context → the keys are absent, not null', async () => {
        const store = await fresh();
        const event = await onlyEvent(store, () => store.importPackage({ name: 'tiny.aasx', package: tinyPackage('1') }));
        for (const key of ['owner', 'actorId', 'actorName', 'cause', 'changeSetId']) expect(event).not.toHaveProperty(key);
        expect(event.data['owner']).toBeNull();
      });

      it('create / update / delete of a submodel → exact payloads, revisions and subject', async () => {
        const { store, packageId } = await withPackage('ws1');
        const id = 'urn:example:sm:new';
        const content = { modelType: 'Submodel', id, idShort: 'Extra', semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: 'urn:s' }] } };
        const base = {
          packageId,
          modelType: 'Submodel',
          id,
          idShort: 'Extra',
          semanticId: 'urn:s',
          globalAssetId: 'urn:example:asset:1',
          aasId: 'urn:example:aas:1',
        };

        const created = await onlyEvent(store, () => store.createIdentifiable(packageId, content));
        expect(created.type).toBe(EVENT_TYPES.modelSubmodelCreated);
        expect(created.subject).toBe(`packages/${packageId}/submodels/${b64url(id)}`);
        expect(created.owner).toBe('ws1');
        expect(created.packageRevision).toBe(2);
        expect(created.data).toEqual({ ...base, operation: 'create', identifiableRevision: 1, packageRevision: 2 });

        const updated = await onlyEvent(store, () =>
          runAsActor({ id: 'user_1', name: 'Lee' }, () =>
            runWithChange({ cause: 'edit', changeSetId: 'chg_2' }, () =>
              store.updateIdentifiable(packageId, 'Submodel', id, { ...content, idShort: 'Renamed' }, { expectedRevision: 1 }),
            ),
          ),
        );
        expect(updated).toMatchObject({ type: EVENT_TYPES.modelSubmodelUpdated, packageRevision: 3, actorId: 'user_1', cause: 'edit', changeSetId: 'chg_2' });
        expect(updated.data).toEqual({
          ...base,
          idShort: 'Renamed',
          operation: 'update',
          identifiableRevision: 2,
          packageRevision: 3,
          actor: { id: 'user_1', name: 'Lee' },
        });

        const deleted = await onlyEvent(store, () => store.deleteIdentifiable(packageId, 'Submodel', id));
        expect(deleted.type).toBe(EVENT_TYPES.modelSubmodelDeleted);
        expect(deleted.data).toEqual({ ...base, idShort: 'Renamed', operation: 'delete', identifiableRevision: 2, packageRevision: 4 });
        expect(deleted.seq).toBeGreaterThan(updated.seq);
        expect(updated.seq).toBeGreaterThan(created.seq);
      });

      it('an explicit options.actor wins over the request context', async () => {
        const { store, packageId } = await withPackage();
        const event = await onlyEvent(store, () =>
          runAsActor({ id: 'context', name: 'Context' }, () =>
            store.updateIdentifiable(packageId, 'Submodel', 'urn:example:sm:1', tinyPackage('1').environment.submodels![0] as never, {
              actor: { id: 'explicit', name: 'Explicit' },
            }),
          ),
        );
        expect(event).toMatchObject({ actorId: 'explicit', actorName: 'Explicit' });
        expect(event.data['actor']).toEqual({ id: 'explicit', name: 'Explicit' });
      });

      it('shells and concept descriptions get their own types; asset ids follow the first shell after the change', async () => {
        const { store, packageId } = await withPackage();
        const cd = await onlyEvent(store, () => store.createIdentifiable(packageId, { modelType: 'ConceptDescription', id: 'urn:example:cd:1' }));
        expect(cd.type).toBe(EVENT_TYPES.modelConceptDescriptionCreated);
        expect(cd.subject).toBe(`packages/${packageId}/concept-descriptions/${b64url('urn:example:cd:1')}`);
        expect(cd.data['idShort']).toBeNull();
        expect(cd.data['semanticId']).toBeNull();

        const removed = await onlyEvent(store, () => store.deleteIdentifiable(packageId, 'AssetAdministrationShell', 'urn:example:aas:1'));
        expect(removed.type).toBe(EVENT_TYPES.modelShellDeleted);
        expect(removed.subject).toBe(`packages/${packageId}/shells/${b64url('urn:example:aas:1')}`);
        // No shell left after the change
        expect(removed.data).toMatchObject({ globalAssetId: null, aasId: null });
      });

      it('putPackageFile / deletePackageFile → model.package.file.changed', async () => {
        const { store, packageId } = await withPackage();
        const file = { part: '/aasx/files/manual.pdf', role: 'supplementary' as const, contentType: 'application/pdf', data: new Uint8Array([1, 2]) };
        const put = await onlyEvent(store, () => store.putPackageFile(packageId, file));
        expect(put).toMatchObject({ type: EVENT_TYPES.modelPackageFileChanged, subject: `packages/${packageId}`, packageRevision: 2 });
        expect(put.data).toEqual({ packageId, part: file.part, role: 'supplementary', operation: 'put' });
        const gone = await onlyEvent(store, () => store.deletePackageFile(packageId, file.part));
        expect(gone.packageRevision).toBe(3);
        expect(gone.data).toEqual({ packageId, part: file.part, role: 'supplementary', operation: 'delete' });
      });

      it('deletePackage → model.package.deleted with the last revision + 1 and the owner it had', async () => {
        const { store, packageId } = await withPackage('ws1');
        await store.createIdentifiable(packageId, { modelType: 'ConceptDescription', id: 'urn:example:cd:x' });
        const event = await onlyEvent(store, () => runWithChange({ cause: 'edit' }, () => store.deletePackage(packageId)));
        expect(event).toMatchObject({ type: EVENT_TYPES.modelPackageDeleted, packageRevision: 3, owner: 'ws1', cause: 'edit', subject: `packages/${packageId}` });
        expect(event.data).toEqual({ packageId, name: 'tiny.aasx', globalAssetId: 'urn:example:asset:1', aasId: 'urn:example:aas:1' });
        // Events outlive the package
        expect((await store.readEvents({ after: 0, limit: 100, packageId })).items.length).toBeGreaterThanOrEqual(3);
      });
    });

    // ── 2 · failures record nothing ──

    it('a failed change records no event — stale revision, duplicate id, missing part, missing package', async () => {
      const { store, packageId } = await withPackage();
      const before = await lastSeq(store);
      const content = tinyPackage('1').environment.submodels![0] as never;
      await expect(store.updateIdentifiable(packageId, 'Submodel', 'urn:example:sm:1', content, { expectedRevision: 99 })).rejects.toBeInstanceOf(ConflictError);
      await expect(store.deleteIdentifiable(packageId, 'Submodel', 'urn:example:sm:1', { expectedRevision: 99 })).rejects.toBeInstanceOf(ConflictError);
      await expect(store.createIdentifiable(packageId, content)).rejects.toThrow();
      await expect(store.deletePackageFile(packageId, '/nope')).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.deletePackage('pkg_missing')).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.putPackageFile('pkg_missing', { part: '/a', role: 'extra', contentType: 'x', data: new Uint8Array() })).rejects.toBeInstanceOf(NotFoundError);
      expect(await eventsAfter(store, before)).toEqual([]);
    });

    // ── 3 · reading ──

    it('readEvents — seq order, limit, type filters, packageId, audit and workspace scope', async () => {
      const store = await fresh();
      const mine = (await store.importPackage({ name: 'a', package: tinyPackage('a'), owner: 'ws1' })).id;
      const theirs = (await store.importPackage({ name: 'b', package: tinyPackage('b'), owner: 'ws2' })).id;
      const shared = (await store.importPackage({ name: 'c', package: tinyPackage('c') })).id;
      await store.appendEvents([
        ev('r1', { packageId: mine }),
        ev('r2', { packageId: theirs, type: EVENT_TYPES.equipmentAlarmRaised }),
        ev('a1', { type: EVENT_TYPES.integrationAudit }),
      ]);

      const all = (await store.readEvents({ after: 0, limit: 1000, includeAudit: true })).items;
      expect(all).toHaveLength(6);
      expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));

      const page = await store.readEvents({ after: all[1]!.seq, limit: 2 });
      expect(page.items.map((e) => e.id)).toEqual([all[2]!.id, all[3]!.id]);
      expect(page.oldestSeq).toBe(all[0]!.seq);
      expect(page.lastSeq).toBe(all[5]!.seq);

      const ids = async (query: Partial<Parameters<AasStore['readEvents']>[0]>, scope?: { owner: string }): Promise<string[]> =>
        (await store.readEvents({ after: 0, limit: 1000, ...query }, scope)).items.map((e) => e.id);
      expect(await ids({})).not.toContain('a1');
      expect(await ids({ includeAudit: true })).toContain('a1');
      expect(await ids({ types: [EVENT_TYPES.equipmentStateChanged] })).toEqual(['r1']);
      expect(await ids({ types: ['equipment.*'] })).toEqual(['r1', 'r2']);
      expect(await ids({ types: ['kr.vexplor.aas.model.package.*'] })).toHaveLength(3);
      expect(await ids({ types: ['equipment.alarm.raised.v1', 'model.package.created.v1'] })).toHaveLength(4);
      expect(await ids({ types: ['*'] })).toHaveLength(5);
      expect(await ids({ packageId: theirs })).toEqual([all[1]!.id, 'r2']);
      // Workspace scope: own and ownerless rows only
      const scoped = await ids({ includeAudit: true }, { owner: 'ws1' });
      expect(scoped).toEqual([all[0]!.id, all[2]!.id, 'r1', 'a1']);
      expect(scoped).not.toContain('r2');
      expect(all[2]!.packageId).toBe(shared);
      // limit is clamped, not refused
      expect((await store.readEvents({ after: 0, limit: 0 })).items).toHaveLength(1);
    });

    it('an empty log reports oldestSeq null and lastSeq 0', async () => {
      const store = await fresh();
      expect(await store.readEvents({ after: 0, limit: 10 })).toEqual({ items: [], oldestSeq: null, lastSeq: 0 });
    });

    // ── 4 · append ──

    it('appendEvents — duplicates are skipped, only new rows return, owner is copied from the package', async () => {
      const { store, packageId } = await withPackage('ws1');
      const first = await store.appendEvents([ev('d1', { packageId, subject: 'urn:example:asset:1', cause: 'system' }), ev('d1'), ev('d2')]);
      expect(first.map((e) => e.id)).toEqual(['d1', 'd2']);
      expect(first[0]).toMatchObject({ owner: 'ws1', packageId, subject: 'urn:example:asset:1', cause: 'system', time: '2026-10-14T00:00:00.000Z' });
      expect(first[0]!.data).toEqual(ev('d1').data);
      expect(first[1]).not.toHaveProperty('owner');
      expect(await store.appendEvents([ev('d1'), ev('d3')])).toHaveLength(1);
      expect((await store.readEvents({ after: 0, limit: 100, types: [EVENT_TYPES.equipmentStateChanged] })).items.map((e) => e.id)).toEqual(['d1', 'd2', 'd3']);
    });

    // ── 5 · prune ──

    it('pruneEvents removes only rows recorded before the cut-off; oldestSeq advances', async () => {
      const store = await fresh();
      const [old] = await store.appendEvents([ev('p1')]);
      await sleep(15);
      const [young] = await store.appendEvents([ev('p2')]);
      expect(Date.parse(young!.recordedAt)).toBeGreaterThan(Date.parse(old!.recordedAt));
      expect(await store.pruneEvents(young!.recordedAt)).toBe(1);
      const page = await store.readEvents({ after: 0, limit: 10 });
      expect(page.items.map((e) => e.id)).toEqual(['p2']);
      expect(page.oldestSeq).toBe(young!.seq);
      // A pruned id may be appended again — it is a new row with a new seq
      const [again] = await store.appendEvents([ev('p1')]);
      expect(again!.seq).toBeGreaterThan(young!.seq);
    });

    // ── 6 · subscriptions ──

    it('subscriptions — create, read with secrets, list without, patch, delete', async () => {
      const store = await fresh();
      const secrets = { keyId: 'k1', secretSealed: 'k1:AAEC/+==', previousSealed: 'k0:old', previousUntil: at(86400), credentialsSealed: 'k1:creds' };
      const made = await store.createSubscription(subscription({ secrets, createdBy: 'user_1', kind: 'mqtt', url: 'mqtt://broker:1883' }));
      expect(made.id).toMatch(/^sub_[0-9a-f]{32}$/);
      expect(made).toMatchObject({ name: 'MES', kind: 'mqtt', enabled: true, consecutiveDead: 0, createdBy: 'user_1', options: { topicPrefix: 'plant/a' } });
      expect(made.createdAt).toMatch(ISO);
      expect(made).not.toHaveProperty('secrets');

      const full = await store.getSubscription(made.id);
      expect(full?.secrets).toEqual(secrets);
      const listed = await store.listSubscriptions();
      expect(listed).toEqual([made]);
      expect(JSON.stringify(listed)).not.toContain('k1:AAEC');

      const disabled = await store.updateSubscription(made.id, { enabled: false, disabledReason: 'gone', consecutiveDead: 3, lastSuccessAt: at(5) });
      expect(disabled).toMatchObject({ enabled: false, disabledReason: 'gone', consecutiveDead: 3, lastSuccessAt: at(5), name: 'MES' });
      const cleared = await store.updateSubscription(made.id, { enabled: true, disabledReason: undefined, lastSuccessAt: undefined, types: ['model.*'], packageIds: ['pkg_9'] });
      expect(cleared).not.toHaveProperty('disabledReason');
      expect(cleared).not.toHaveProperty('lastSuccessAt');
      expect(cleared).toMatchObject({ enabled: true, types: ['model.*'], packageIds: ['pkg_9'], consecutiveDead: 3 });

      await store.updateSubscription(made.id, { secrets: { keyId: 'k2', secretSealed: 'k2:new' }, secretHint: 'wxyz' });
      expect((await store.getSubscription(made.id))?.secrets).toEqual({ keyId: 'k2', secretSealed: 'k2:new' });
      expect((await store.getSubscription(made.id))?.secretHint).toBe('wxyz');

      expect(await store.updateSubscription('sub_missing', { name: 'x' })).toBeUndefined();
      expect(await store.deleteSubscription(made.id)).toBe(true);
      expect(await store.deleteSubscription(made.id)).toBe(false);
      expect(await store.getSubscription(made.id)).toBeUndefined();
      expect(await store.listSubscriptions()).toEqual([]);
    });

    // ── 7 · deliveries: enqueue and claim ──

    it('deliveries — enqueue is idempotent, claim leases, an expired lease is reclaimable', async () => {
      const store = await fresh();
      const sub = await store.createSubscription(subscription());
      const rows = [1, 2, 3].map((n) => ({ subscriptionId: sub.id, eventSeq: n, eventId: `e${n}` }));
      expect(await store.enqueueDeliveries([...rows, rows[0]!, { subscriptionId: 'sub_unknown', eventSeq: 1, eventId: 'e1' }], T0)).toBe(3);
      expect(await store.enqueueDeliveries(rows, at(1))).toBe(0);

      const first = await store.claimDeliveries(T0, 2, 60_000);
      expect(first.map((row) => row.eventSeq)).toEqual([1, 2]);
      expect(first[0]).toMatchObject({ status: 'in-flight', attempts: 1, leaseUntil: at(60), nextAttemptAt: T0, eventId: 'e1', subscriptionId: sub.id });
      // Within the lease the same rows are never handed out again
      const second = await store.claimDeliveries(at(1), 10, 60_000);
      expect(second.map((row) => row.eventSeq)).toEqual([3]);
      expect(await store.claimDeliveries(at(30), 10, 60_000)).toEqual([]);
      // After the lease: reclaimable, attempts keep counting
      const again = await store.claimDeliveries(at(61), 10, 60_000);
      expect(again.map((row) => row.eventSeq)).toEqual([1, 2]);
      expect(again.map((row) => row.attempts)).toEqual([2, 2]);
      // A retry is not due before its nextAttemptAt — only the two expired leases come back at 599 s
      await store.completeDelivery(again[0]!.id, { outcome: 'retry', at: at(62), nextAttemptAt: at(600), statusCode: 503, error: 'busy', durationMs: 12, address: '10.0.0.5' });
      expect((await store.claimDeliveries(at(599), 10, 60_000)).map((row) => row.eventSeq)).toEqual([2, 3]);
      expect((await store.claimDeliveries(at(600), 10, 60_000)).map((row) => row.eventSeq)).toEqual([1]);
    });

    // ── 8 · deliveries: completion, redelivery, stats, prune, cascade ──

    it('deliveries — complete, redeliver, list, stats, prune and cascade', async () => {
      const store = await fresh();
      const sub = await store.createSubscription(subscription());
      const idle = await store.createSubscription(subscription({ name: 'idle' }));
      await store.enqueueDeliveries([1, 2, 3, 4].map((n) => ({ subscriptionId: sub.id, eventSeq: n, eventId: `e${n}` })), T0);
      const [a, b, c] = await store.claimDeliveries(T0, 3, 60_000);

      await store.completeDelivery(a!.id, { outcome: 'retry', at: at(1), nextAttemptAt: at(10), statusCode: 500, error: 'boom', durationMs: 40, address: '10.0.0.5' });
      expect(await store.getDelivery(a!.id)).toMatchObject({ status: 'pending', nextAttemptAt: at(10), lastStatusCode: 500, lastError: 'boom', lastDurationMs: 40, lastAddress: '10.0.0.5', updatedAt: at(1) });
      expect(await store.getDelivery(a!.id)).not.toHaveProperty('leaseUntil');
      await store.completeDelivery(a!.id, { outcome: 'succeeded', at: at(2), statusCode: 204 });
      const ok = await store.getDelivery(a!.id);
      expect(ok).toMatchObject({ status: 'succeeded', lastStatusCode: 204, updatedAt: at(2) });
      // "last" describes the last attempt only — fields it did not produce are cleared
      for (const key of ['lastError', 'lastDurationMs', 'lastAddress']) expect(ok).not.toHaveProperty(key);
      await store.completeDelivery(b!.id, { outcome: 'dead', at: at(3), error: 'gone' });
      await store.completeDelivery(c!.id, { outcome: 'retry', at: at(4) });
      expect((await store.getDelivery(c!.id))?.nextAttemptAt).toBe(at(4));

      // Unknown ids are no-ops
      await store.completeDelivery('999999', { outcome: 'succeeded', at: at(5) });
      await store.completeDelivery('not-a-number', { outcome: 'succeeded', at: at(5) });
      expect(await store.getDelivery('999999')).toBeUndefined();
      expect(await store.getDelivery('not-a-number')).toBeUndefined();
      expect(await store.redeliver('999999', at(5))).toBe(false);

      expect(await store.redeliver(b!.id, at(6))).toBe(true);
      expect(await store.getDelivery(b!.id)).toMatchObject({ status: 'pending', nextAttemptAt: at(6), attempts: 1, lastError: 'gone' });
      await store.completeDelivery(b!.id, { outcome: 'dead', at: at(7), error: 'gone again' });

      const stats = await store.deliveryStats();
      expect(stats.find((s) => s.subscriptionId === sub.id)).toEqual({ subscriptionId: sub.id, pending: 2, inFlight: 0, dead: 1, succeeded: 1, oldestPendingAt: T0 });
      expect(stats.find((s) => s.subscriptionId === idle.id)).toEqual({ subscriptionId: idle.id, pending: 0, inFlight: 0, dead: 0, succeeded: 0 });

      const page1 = await store.listDeliveries(sub.id, { limit: 3 });
      expect(page1.items.map((row) => row.eventSeq)).toEqual([4, 3, 2]);
      expect(page1.cursor).toBe(page1.items[2]!.id);
      const page2 = await store.listDeliveries(sub.id, { limit: 3, cursor: page1.cursor! });
      expect(page2.items.map((row) => row.eventSeq)).toEqual([1]);
      expect(page2.cursor).toBeUndefined();
      expect((await store.listDeliveries(sub.id, { status: 'dead' })).items.map((row) => row.eventSeq)).toEqual([2]);

      // Succeeded rows before at(5) and dead rows before at(7) — the dead row was updated at at(7), so it stays
      expect(await store.pruneDeliveries(at(5), at(7))).toBe(1);
      expect(await store.getDelivery(a!.id)).toBeUndefined();
      expect(await store.getDelivery(b!.id)).toBeDefined();
      expect(await store.pruneDeliveries(at(5), at(8))).toBe(1);

      expect(await store.deleteSubscription(sub.id)).toBe(true);
      expect(await store.getDelivery(c!.id)).toBeUndefined();
      expect((await store.listDeliveries(sub.id)).items).toEqual([]);
      expect((await store.deliveryStats()).map((s) => s.subscriptionId)).toEqual([idle.id]);
    });

    // ── 9 · configuration and external references ──

    it('server and package config — revision 1 → 2, stale revision conflicts, unknown package', async () => {
      const { store, packageId } = await withPackage();
      expect(await store.getServerIntegrationConfig()).toBeUndefined();
      const first = await runAsActor({ id: 'user_1', name: 'Admin' }, () => store.putServerIntegrationConfig({ schema: 'x', list: [1, 'a'] }, 0));
      expect(first).toMatchObject({ value: { schema: 'x', list: [1, 'a'] }, revision: 1, actorId: 'user_1', actorName: 'Admin' });
      expect(first.updatedAt).toMatch(ISO);
      expect((await store.putServerIntegrationConfig({ schema: 'y' })).revision).toBe(2);
      await expect(store.putServerIntegrationConfig({ schema: 'z' }, 1)).rejects.toBeInstanceOf(ConflictError);
      await expect(store.putServerIntegrationConfig({ schema: 'z' }, 0)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.getServerIntegrationConfig()).toMatchObject({ value: { schema: 'y' }, revision: 2 });
      expect(await store.getServerIntegrationConfig()).not.toHaveProperty('actorId');

      await expect(store.putPackageIntegrationConfig(packageId, { a: 1 }, 1)).rejects.toBeInstanceOf(ConflictError);
      expect((await store.putPackageIntegrationConfig(packageId, { a: 1 })).revision).toBe(1);
      expect((await store.putPackageIntegrationConfig(packageId, { a: 2 }, 1)).revision).toBe(2);
      expect(await store.getPackageIntegrationConfig(packageId)).toMatchObject({ value: { a: 2 }, revision: 2 });
      await expect(store.putPackageIntegrationConfig('pkg_missing', {})).rejects.toBeInstanceOf(NotFoundError);
      expect(await store.getPackageIntegrationConfig('pkg_missing')).toBeUndefined();
      // A string config value survives as a string (jsonb read back as text)
      expect((await store.putPackageIntegrationConfig(packageId, 'just text')).value).toBe('just text');
      expect((await store.getPackageIntegrationConfig(packageId))?.value).toBe('just text');
    });

    it('external refs — revisions, uniqueness across packages and subjects, idempotent re-put, lookup', async () => {
      const store = await fresh();
      const p1 = (await store.importPackage({ name: 'a', package: tinyPackage('a') })).id;
      const p2 = (await store.importPackage({ name: 'b', package: tinyPackage('b') })).id;
      const doc1 = refsDoc('urn:example:asset:a', [
        { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001' },
        { system: 'sap-s4:PRD:100', type: 'costCenter', id: 'CC1' },
      ]);
      const saved = await store.putExternalRefs(p1, doc1, 0);
      expect(saved).toMatchObject({ value: doc1, revision: 1 });
      // Same doc again: no conflict with itself, revision still moves (general revision rule)
      expect((await store.putExternalRefs(p1, doc1, 1)).revision).toBe(2);
      await expect(store.putExternalRefs(p1, doc1, 1)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', '10001')).toEqual([{ packageId: p1, subject: 'asset|urn:example:asset:a' }]);
      expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', 'nope')).toEqual([]);

      // Another package claiming the same key → both claims, existing first; nothing written
      const clash = refsDoc('urn:example:asset:b', [
        { system: 'icube:WACE', type: 'equipmentCode', id: 'E-1' },
        { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001' },
      ]);
      const error = await store.putExternalRefs(p2, clash).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExternalRefConflictError);
      expect((error as ExternalRefConflictError).claims).toEqual([
        { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001', packageId: p1, subject: 'asset|urn:example:asset:a' },
        { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001', packageId: p2, subject: 'asset|urn:example:asset:b' },
      ]);
      expect(await store.getExternalRefs(p2)).toBeUndefined();
      expect(await store.findExternalRef('icube:WACE', 'equipmentCode', 'E-1')).toEqual([]);

      // Two subjects of one doc claiming one key
      const twice: ExternalRefsDoc = {
        schema: 'vexplor.externalRefs/1',
        subjects: [
          { subject: { kind: 'asset', globalAssetId: 'g' }, refs: [{ system: 's', type: 't', id: '1' }] },
          { subject: { kind: 'tool', globalAssetId: 'g', key: 'k' }, refs: [{ system: 's', type: 't', id: '1' }] },
        ],
      };
      const inner = await store.putExternalRefs(p2, twice).catch((caught: unknown) => caught);
      expect((inner as ExternalRefConflictError).claims.map((claim) => claim.subject)).toEqual(['asset|g', 'tool|g|k']);

      // The first package releases the key by dropping it — then the second may take it
      await store.putExternalRefs(p1, refsDoc('urn:example:asset:a', [{ system: 'sap-s4:PRD:100', type: 'costCenter', id: 'CC1' }]));
      expect((await store.putExternalRefs(p2, clash)).revision).toBe(1);
      expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', '10001')).toEqual([{ packageId: p2, subject: 'asset|urn:example:asset:b' }]);
      expect((await store.listExternalRefs()).map((entry) => [entry.packageId, entry.refs.revision])).toEqual([[p1, 3], [p2, 1]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
      await expect(store.putExternalRefs('pkg_missing', doc1)).rejects.toBeInstanceOf(NotFoundError);
    });

    // ── review fixes: orphan owner (H1), gap-free dedupe (L2), refs events (M3), refs batch (M4) ──

    it('appendEvents owner — package owner, explicit owner, explicit null, and ORPHAN_OWNER for a package that is gone', async () => {
      const store = await fresh();
      const kept = (await store.importPackage({ name: 'a', package: tinyPackage('a'), owner: 'ws1' })).id;
      const gone = (await store.importPackage({ name: 'b', package: tinyPackage('b'), owner: 'ws2' })).id;
      await store.deletePackage(gone);
      const rows = await store.appendEvents([
        ev('o1', { packageId: kept }),
        ev('o2', { packageId: gone }),
        ev('o3', { packageId: gone, owner: 'ws2' }),
        ev('o4', { packageId: gone, owner: null }),
        ev('o5', { packageId: kept, owner: 'ws9' }),
        ev('o6'),
      ]);
      expect(rows.map((row) => [row.id, row.owner ?? 'shared'])).toEqual([
        ['o1', 'ws1'],
        ['o2', ORPHAN_OWNER],
        ['o3', 'ws2'],
        ['o4', 'shared'],
        ['o5', 'ws9'],
        ['o6', 'shared'],
      ]);
      // The input's owner is an instruction, never a stored null
      for (const row of rows) expect(row.owner).not.toBeNull();
      // A workspace reader never gets the orphan row
      const ws1 = (await store.readEvents({ after: 0, limit: 100 }, { owner: 'ws1' })).items.map((row) => row.id);
      expect(ws1).toEqual(expect.arrayContaining(['o1', 'o4', 'o6']));
      expect(ws1).not.toContain('o2');
      expect(ws1).not.toContain('o3');
    });

    it('a deduplicated append takes no seq — the next row follows without a gap', async () => {
      const store = await fresh();
      const [a] = await store.appendEvents([ev('g1')]);
      expect(await store.appendEvents([ev('g1')])).toEqual([]);
      expect(await store.appendEvents([ev('g1'), ev('g1')])).toEqual([]);
      const [b] = await store.appendEvents([ev('g1'), ev('g2')]);
      expect(b!.seq).toBe(a!.seq + 1);
    });

    it('putExternalRefs records model.externalrefs.updated in the same write; failed writes record nothing', async () => {
      const { store, packageId } = await withPackage('ws1');
      const event = await onlyEvent(store, () =>
        runAsActor({ id: 'user_1', name: 'Kim' }, () =>
          runWithChange({ cause: 'external-refs', changeSetId: 'chg_r' }, () =>
            store.putExternalRefs(packageId, refsDoc('urn:example:asset:1', [{ system: 's', type: 't', id: '1' }]), 0),
          ),
        ),
      );
      expect(event).toMatchObject({
        type: EVENT_TYPES.modelExternalRefsUpdated,
        packageId,
        subject: `packages/${packageId}`,
        owner: 'ws1',
        actorId: 'user_1',
        cause: 'external-refs',
        changeSetId: 'chg_r',
      });
      // No packageRevision: the package did not change, and receivers skip revisions they already applied
      expect(event).not.toHaveProperty('packageRevision');
      expect(event.data).toEqual({ packageId, revision: 1 });

      const other = (await store.importPackage({ name: 'o', package: tinyPackage('o') })).id;
      const before = await lastSeq(store);
      await expect(store.putExternalRefs(packageId, refsDoc('urn:x', []), 0)).rejects.toBeInstanceOf(ConflictError);
      await expect(store.putExternalRefs(other, refsDoc('urn:o', [{ system: 's', type: 't', id: '1' }]))).rejects.toBeInstanceOf(ExternalRefConflictError);
      await expect(store.putExternalRefs('pkg_missing', refsDoc('urn:x', []))).rejects.toBeInstanceOf(NotFoundError);
      expect(await eventsAfter(store, before)).toEqual([]);
    });

    it('putExternalRefsBatch — applied in order (a key may move), all or nothing, one event per item', async () => {
      const store = await fresh();
      const p1 = (await store.importPackage({ name: 'a', package: tinyPackage('a') })).id;
      const p2 = (await store.importPackage({ name: 'b', package: tinyPackage('b') })).id;
      await store.putExternalRefs(p1, refsDoc('urn:a', [{ system: 's', type: 't', id: 'K' }]));

      // Failure on the second item: neither item is written, no event is recorded
      const before = await lastSeq(store);
      await expect(
        store.putExternalRefsBatch([
          { packageId: p1, doc: refsDoc('urn:a', [{ system: 's', type: 't', id: 'K2' }]), expectedRevision: 1 },
          { packageId: p2, doc: refsDoc('urn:b', []), expectedRevision: 5 },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        store.putExternalRefsBatch([
          { packageId: p2, doc: refsDoc('urn:b', [{ system: 's', type: 't', id: 'NEW' }]) },
          { packageId: p2, doc: refsDoc('urn:b', [{ system: 's', type: 't', id: 'K' }]) },
        ]),
      ).rejects.toBeInstanceOf(ExternalRefConflictError);
      await expect(store.putExternalRefsBatch([{ packageId: p2, doc: refsDoc('urn:b', []) }, { packageId: 'pkg_missing', doc: refsDoc('urn:x', []) }])).rejects.toBeInstanceOf(NotFoundError);
      expect((await store.getExternalRefs(p1))?.revision).toBe(1);
      expect(await store.getExternalRefs(p2)).toBeUndefined();
      expect(await store.findExternalRef('s', 't', 'K')).toEqual([{ packageId: p1, subject: 'asset|urn:a' }]);
      expect(await store.findExternalRef('s', 't', 'NEW')).toEqual([]);
      expect(await eventsAfter(store, before)).toEqual([]);

      // Success: p1 releases K, p2 takes it — in one batch, because items apply in order
      const saved = await store.putExternalRefsBatch([
        { packageId: p1, doc: refsDoc('urn:a', [{ system: 's', type: 't', id: 'K2' }]), expectedRevision: 1 },
        { packageId: p2, doc: refsDoc('urn:b', [{ system: 's', type: 't', id: 'K' }]), expectedRevision: 0 },
      ]);
      expect(saved.map((item) => item.revision)).toEqual([2, 1]);
      expect(await store.findExternalRef('s', 't', 'K')).toEqual([{ packageId: p2, subject: 'asset|urn:b' }]);
      const events = await eventsAfter(store, before);
      expect(events.map((row) => [row.type, row.data])).toEqual([
        [EVENT_TYPES.modelExternalRefsUpdated, { packageId: p1, revision: 2 }],
        [EVENT_TYPES.modelExternalRefsUpdated, { packageId: p2, revision: 1 }],
      ]);
      expect(await store.putExternalRefsBatch([])).toEqual([]);
    });

    // ── 10 · runtime state and package deletion ──

    it('runtime state round-trips any JSON value; unknown package is refused', async () => {
      const { store, packageId } = await withPackage();
      expect(await store.getRuntimeState('dispatcher:cursor')).toBeUndefined();
      await store.putRuntimeState('dispatcher:cursor', 42);
      await store.putRuntimeState('detector:x', { open: [{ id: 'a', since: T0 }], text: 'quote " and ; semicolon' }, packageId);
      await store.putRuntimeState('plain', 'text');
      expect(await store.getRuntimeState('dispatcher:cursor')).toBe(42);
      expect(await store.getRuntimeState('detector:x')).toEqual({ open: [{ id: 'a', since: T0 }], text: 'quote " and ; semicolon' });
      expect(await store.getRuntimeState('plain')).toBe('text');
      await store.putRuntimeState('dispatcher:cursor', 43);
      expect(await store.getRuntimeState('dispatcher:cursor')).toBe(43);
      await expect(store.putRuntimeState('k', 1, 'pkg_missing')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('deletePackage removes its config, refs (and keys) and runtime state — other packages and server rows stay', async () => {
      const store = await fresh();
      const gone = (await store.importPackage({ name: 'a', package: tinyPackage('a') })).id;
      const kept = (await store.importPackage({ name: 'b', package: tinyPackage('b') })).id;
      for (const packageId of [gone, kept]) {
        await store.putPackageIntegrationConfig(packageId, { p: packageId });
        await store.putExternalRefs(packageId, refsDoc(`urn:g:${packageId}`, [{ system: 's', type: 't', id: packageId }]));
        await store.putRuntimeState(`projector:${packageId}`, { p: packageId }, packageId);
      }
      await store.putRuntimeState('dispatcher:cursor', 7);
      await store.putServerIntegrationConfig({ s: 1 });

      await store.deletePackage(gone);
      expect(await store.getPackageIntegrationConfig(gone)).toBeUndefined();
      expect(await store.getExternalRefs(gone)).toBeUndefined();
      expect(await store.findExternalRef('s', 't', gone)).toEqual([]);
      expect(await store.getRuntimeState(`projector:${gone}`)).toBeUndefined();
      expect((await store.listExternalRefs()).map((entry) => entry.packageId)).toEqual([kept]);

      expect(await store.getPackageIntegrationConfig(kept)).toMatchObject({ value: { p: kept } });
      expect(await store.findExternalRef('s', 't', kept)).toEqual([{ packageId: kept, subject: `asset|urn:g:${kept}` }]);
      expect(await store.getRuntimeState(`projector:${kept}`)).toEqual({ p: kept });
      expect(await store.getRuntimeState('dispatcher:cursor')).toBe(7);
      expect((await store.getServerIntegrationConfig())?.value).toEqual({ s: 1 });
      // The freed key can be claimed again
      await store.putExternalRefs(kept, refsDoc(`urn:g:${kept}`, [{ system: 's', type: 't', id: gone }]));
    });
  });
}
