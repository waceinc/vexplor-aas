/**
 * MemoryIntegrationLog — the reference implementation of the integration store port (docs/design/integration-v1.md §3.3).
 * The cross-store conformance suite (WP1) runs the same contract on memory, folder and PostgreSQL; this file pins
 * the reference behaviour other work packages test against before that suite exists.
 */
import {
  ConflictError,
  ExternalRefConflictError,
  MemoryIntegrationLog,
  NotFoundError,
  currentChange,
  runAsActor,
  runWithChange,
  type ExternalRefsDoc,
  type NewEvent,
  type NewSubscription,
} from '@aas/store';
import { describe, expect, it } from 'vitest';

/** pkg_a owned by ws1, pkg_b without owner, everything else missing */
const OWNERS: Record<string, string | undefined> = { pkg_a: 'ws1', pkg_b: undefined };
const ownerOf = (id: string): string | undefined | null => (id in OWNERS ? OWNERS[id] : null);

function clock(start = '2026-10-14T00:00:00.000Z'): { now: () => string; advance: (ms: number) => void } {
  let at = Date.parse(start);
  return { now: () => new Date(at).toISOString(), advance: (ms) => { at += ms; } };
}

function log(options: { maxEvents?: number } = {}) {
  const time = clock();
  let n = 0;
  const store = new MemoryIntegrationLog(ownerOf, { ...options, now: time.now, newId: () => `id-${++n}` });
  return { store, time };
}

const event = (id: string, patch: Partial<NewEvent> = {}): NewEvent => ({
  id,
  type: 'kr.vexplor.aas.equipment.state.changed.v1',
  time: '2026-10-14T00:00:00.000Z',
  data: { n: id },
  ...patch,
});

const subscription = (patch: Partial<NewSubscription> = {}): NewSubscription => ({
  name: 'MES',
  kind: 'webhook',
  url: 'https://mes.example.com/hook',
  types: ['equipment.*'],
  packageIds: [],
  enabled: true,
  options: {},
  secretHint: 'abcd',
  secrets: { keyId: 'k1', secretSealed: 'k1:sealed-bytes' },
  ...patch,
});

describe('MemoryIntegrationLog — events', () => {
  it('appends in seq order, copies the owner from the package, and returns only new rows', async () => {
    const { store } = log();
    const first = await store.appendEvents([event('e1', { packageId: 'pkg_a' }), event('e2', { packageId: 'pkg_b' }), event('e3')]);
    expect(first.map((row) => [row.seq, row.id, row.owner])).toEqual([[1, 'e1', 'ws1'], [2, 'e2', undefined], [3, 'e3', undefined]]);
    expect('owner' in first[1]!).toBe(false);
    const again = await store.appendEvents([event('e2'), event('e4'), event('e4')]);
    expect(again.map((row) => row.id)).toEqual(['e4']);
    const page = await store.readEvents({ after: 0, limit: 100 });
    expect(page.items.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(page).toMatchObject({ oldestSeq: 1, lastSeq: 4 });
  });

  it('reads after a cursor with limit, type filters, package filter, audit exclusion', async () => {
    const { store } = log();
    await store.appendEvents([
      event('a', { packageId: 'pkg_a' }),
      event('b', { type: 'kr.vexplor.aas.model.submodel.updated.v1', packageId: 'pkg_b' }),
      event('c', { type: 'kr.vexplor.aas.integration.audit.v1' }),
      event('d', { type: 'kr.vexplor.aas.equipment.alarm.raised.v1', packageId: 'pkg_a' }),
    ]);
    const ids = async (query: Parameters<typeof store.readEvents>[0]) => (await store.readEvents(query)).items.map((row) => row.id);
    expect(await ids({ after: 0, limit: 10 })).toEqual(['a', 'b', 'd']);
    expect(await ids({ after: 0, limit: 10, includeAudit: true })).toEqual(['a', 'b', 'c', 'd']);
    expect(await ids({ after: 1, limit: 1 })).toEqual(['b']);
    expect(await ids({ after: 0, limit: 10, types: ['equipment.*'] })).toEqual(['a', 'd']);
    expect(await ids({ after: 0, limit: 10, types: ['kr.vexplor.aas.model.submodel.updated.v1'] })).toEqual(['b']);
    expect(await ids({ after: 0, limit: 10, packageId: 'pkg_a' })).toEqual(['a', 'd']);
    expect(await ids({ after: 0, limit: 0 })).toEqual(['a']); // clamped to 1
  });

  it('a workspace scope sees its own and ownerless rows only', async () => {
    const { store } = log();
    store.recordModelEvent({ ...event('mine', { packageId: 'pkg_a' }), owner: 'ws1' });
    store.recordModelEvent({ ...event('other', { packageId: 'pkg_x' }), owner: 'ws2' });
    store.recordModelEvent(event('shared'));
    const page = await store.readEvents({ after: 0, limit: 10 }, { owner: 'ws1' });
    expect(page.items.map((row) => row.id)).toEqual(['mine', 'shared']);
    expect(store.recordModelEvent(event('mine'))).toBeUndefined(); // duplicate id
  });

  it('prunes by record time and the oldest seq advances', async () => {
    const { store, time } = log();
    await store.appendEvents([event('old')]);
    time.advance(60_000);
    await store.appendEvents([event('new')]);
    expect(await store.pruneEvents(new Date(Date.parse('2026-10-14T00:00:30.000Z')).toISOString())).toBe(1);
    const page = await store.readEvents({ after: 0, limit: 10 });
    expect(page.items.map((row) => row.id)).toEqual(['new']);
    expect(page.oldestSeq).toBe(2);
    expect(page.lastSeq).toBe(2);
    // seq never restarts after a prune
    expect((await store.appendEvents([event('later')]))[0]!.seq).toBe(3);
  });

  it('caps the log: the oldest rows drop out', async () => {
    const { store } = log({ maxEvents: 3 });
    await store.appendEvents(['1', '2', '3', '4', '5'].map((id) => event(id)));
    const page = await store.readEvents({ after: 0, limit: 10 });
    expect(page.items.map((row) => row.id)).toEqual(['3', '4', '5']);
    expect(page.oldestSeq).toBe(3);
  });

  it('returned rows are copies — mutating them does not change the log', async () => {
    const { store } = log();
    const input = event('e1');
    const [row] = await store.appendEvents([input]);
    row!.data.n = 'changed';
    (input.data as Record<string, unknown>).n = 'changed too';
    expect((await store.readEvents({ after: 0, limit: 1 })).items[0]!.data).toEqual({ n: 'e1' });
  });
});

describe('MemoryIntegrationLog — subscriptions and deliveries', () => {
  it('subscription CRUD: secrets only through getSubscription, patch removes fields given as undefined', async () => {
    const { store } = log();
    const created = await store.createSubscription(subscription({ enabled: false, disabledReason: '410 from receiver' }));
    expect(created).toMatchObject({ id: 'sub_id1', consecutiveDead: 0, disabledReason: '410 from receiver' });
    expect('secrets' in created).toBe(false);
    expect(JSON.stringify(await store.listSubscriptions())).not.toContain('sealed-bytes');
    expect((await store.getSubscription(created.id))!.secrets).toEqual({ keyId: 'k1', secretSealed: 'k1:sealed-bytes' });
    const updated = await store.updateSubscription(created.id, { enabled: true, disabledReason: undefined, secrets: { keyId: 'k1', secretSealed: 'new', previousSealed: 'k1:sealed-bytes', previousUntil: '2026-10-15T00:00:00.000Z' } });
    expect(updated!.enabled).toBe(true);
    expect('disabledReason' in updated!).toBe(false);
    expect((await store.getSubscription(created.id))!.secrets.previousSealed).toBe('k1:sealed-bytes');
    expect(await store.updateSubscription('sub_missing', { name: 'x' })).toBeUndefined();
  });

  it('enqueue is idempotent per (subscription, event) and skips unknown subscriptions', async () => {
    const { store, time } = log();
    const sub = await store.createSubscription(subscription());
    const now = time.now();
    expect(await store.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 1, eventId: 'e1' }, { subscriptionId: sub.id, eventSeq: 1, eventId: 'e1' }], now)).toBe(1);
    expect(await store.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 1, eventId: 'e1' }, { subscriptionId: 'sub_gone', eventSeq: 2, eventId: 'e2' }], now)).toBe(0);
  });

  it('claim: never the same row twice within a lease, reclaimable after it expires, attempts count claims', async () => {
    const { store, time } = log();
    const sub = await store.createSubscription(subscription());
    await store.enqueueDeliveries([1, 2, 3].map((seq) => ({ subscriptionId: sub.id, eventSeq: seq, eventId: `e${seq}` })), time.now());
    const first = await store.claimDeliveries(time.now(), 2, 60_000);
    expect(first.map((row) => [row.eventSeq, row.status, row.attempts])).toEqual([[1, 'in-flight', 1], [2, 'in-flight', 1]]);
    expect((await store.claimDeliveries(time.now(), 10, 60_000)).map((row) => row.eventSeq)).toEqual([3]);
    time.advance(30_000);
    expect(await store.claimDeliveries(time.now(), 10, 60_000)).toEqual([]);
    time.advance(31_000);
    const again = await store.claimDeliveries(time.now(), 10, 60_000);
    expect(again.map((row) => [row.eventSeq, row.attempts])).toEqual([[1, 2], [2, 2], [3, 2]]);
  });

  it('a pending row is not due before its nextAttemptAt', async () => {
    const { store, time } = log();
    const sub = await store.createSubscription(subscription());
    await store.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 1, eventId: 'e1' }], time.now());
    const [row] = await store.claimDeliveries(time.now(), 1, 60_000);
    await store.completeDelivery(row!.id, { outcome: 'retry', at: time.now(), nextAttemptAt: new Date(Date.parse(time.now()) + 10_000).toISOString(), statusCode: 503 });
    expect(await store.claimDeliveries(time.now(), 1, 60_000)).toEqual([]);
    time.advance(10_000);
    expect((await store.claimDeliveries(time.now(), 1, 60_000))[0]!.attempts).toBe(2);
  });

  it('complete: succeeded / retry / dead, last fields describe the last attempt only; redeliver resets; stats; prune; cascade', async () => {
    const { store, time } = log();
    const sub = await store.createSubscription(subscription());
    await store.enqueueDeliveries([1, 2, 3].map((seq) => ({ subscriptionId: sub.id, eventSeq: seq, eventId: `e${seq}` })), time.now());
    const [a, b, c] = await store.claimDeliveries(time.now(), 3, 60_000);
    await store.completeDelivery(a!.id, { outcome: 'retry', at: time.now(), statusCode: 500, error: 'HTTP 500', durationMs: 12, address: '10.0.0.5' });
    expect(await store.getDelivery(a!.id)).toMatchObject({ status: 'pending', lastStatusCode: 500, lastError: 'HTTP 500', nextAttemptAt: time.now() });
    expect((await store.getDelivery(a!.id))!.leaseUntil).toBeUndefined();
    await store.claimDeliveries(time.now(), 1, 60_000);
    await store.completeDelivery(a!.id, { outcome: 'succeeded', at: time.now(), statusCode: 200, durationMs: 8 });
    const done = await store.getDelivery(a!.id);
    expect(done).toMatchObject({ status: 'succeeded', lastStatusCode: 200, attempts: 2 });
    expect('lastError' in done!).toBe(false);
    await store.completeDelivery(b!.id, { outcome: 'dead', at: time.now(), statusCode: 404 });
    await store.completeDelivery('999', { outcome: 'dead', at: time.now() }); // unknown id: no-op

    expect(await store.deliveryStats()).toEqual([{ subscriptionId: sub.id, pending: 0, inFlight: 1, dead: 1, succeeded: 1, oldestPendingAt: c!.createdAt }]);

    expect(await store.redeliver(b!.id, time.now())).toBe(true);
    expect(await store.getDelivery(b!.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await store.redeliver('999', time.now())).toBe(false);

    const list = await store.listDeliveries(sub.id, { limit: 2 });
    expect(list.items.map((row) => row.eventSeq)).toEqual([3, 2]);
    expect((await store.listDeliveries(sub.id, { limit: 2, cursor: list.cursor! })).items.map((row) => row.eventSeq)).toEqual([1]);
    expect((await store.listDeliveries(sub.id, { status: 'succeeded' })).items.map((row) => row.eventSeq)).toEqual([1]);

    // prune: succeeded older than its cut-off goes, the pending row stays whatever its age
    time.advance(1000);
    expect(await store.pruneDeliveries(time.now(), '2000-01-01T00:00:00.000Z')).toBe(1);
    expect(await store.getDelivery(a!.id)).toBeUndefined();

    expect(await store.deleteSubscription(sub.id)).toBe(true);
    expect(await store.getDelivery(b!.id)).toBeUndefined();
    expect(await store.deleteSubscription(sub.id)).toBe(false);
  });
});

describe('MemoryIntegrationLog — config, external refs, runtime state', () => {
  it('config revisions: 1 then 2, stale expected revision → ConflictError, 0 means "never saved", actor recorded', async () => {
    const { store } = log();
    expect(await store.getServerIntegrationConfig()).toBeUndefined();
    const first = await runAsActor({ id: 'user_1', name: 'Admin' }, () => store.putServerIntegrationConfig({ a: 1 }, 0));
    expect(first).toMatchObject({ value: { a: 1 }, revision: 1, actorId: 'user_1', actorName: 'Admin' });
    expect((await store.putServerIntegrationConfig({ a: 2 }, 1)).revision).toBe(2);
    await expect(store.putServerIntegrationConfig({ a: 3 }, 1)).rejects.toBeInstanceOf(ConflictError);
    expect((await store.putServerIntegrationConfig({ a: 4 })).revision).toBe(3);

    expect((await store.putPackageIntegrationConfig('pkg_a', { s: 1 })).revision).toBe(1);
    await expect(store.putPackageIntegrationConfig('pkg_a', { s: 2 }, 0)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.putPackageIntegrationConfig('pkg_missing', { s: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  const refsDoc = (globalAssetId: string, id: string, extra: ExternalRefsDoc['subjects'] = []): ExternalRefsDoc => ({
    schema: 'vexplor.externalRefs/1',
    subjects: [{ subject: { kind: 'asset', globalAssetId }, refs: [{ system: 'sap-s4:PRD:100', type: 'equipment', id }] }, ...extra],
  });

  it('external refs: uniqueness across packages lists both claims; re-putting the same doc is fine; find', async () => {
    const { store } = log();
    await store.putExternalRefs('pkg_a', refsDoc('urn:a', '10001'));
    expect((await store.putExternalRefs('pkg_a', refsDoc('urn:a', '10001'), 1)).revision).toBe(2);
    expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', '10001')).toEqual([{ packageId: 'pkg_a', subject: 'asset|urn:a' }]);

    const error = await store.putExternalRefs('pkg_b', refsDoc('urn:b', '10001')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalRefConflictError);
    expect((error as ExternalRefConflictError).claims).toEqual([
      { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001', packageId: 'pkg_a', subject: 'asset|urn:a' },
      { system: 'sap-s4:PRD:100', type: 'equipment', id: '10001', packageId: 'pkg_b', subject: 'asset|urn:b' },
    ]);
    expect(await store.getExternalRefs('pkg_b')).toBeUndefined(); // nothing written on conflict

    // pkg_a gives the id up; then pkg_b may take it
    await store.putExternalRefs('pkg_a', refsDoc('urn:a', '10002'));
    await store.putExternalRefs('pkg_b', refsDoc('urn:b', '10001'));
    expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', '10001')).toEqual([{ packageId: 'pkg_b', subject: 'asset|urn:b' }]);
    expect((await store.listExternalRefs()).map((entry) => entry.packageId)).toEqual(['pkg_a', 'pkg_b']);
  });

  it('external refs: two subjects of one doc cannot claim the same key; subject strings include the key', async () => {
    const { store } = log();
    const doc = refsDoc('urn:a', '1', [{ subject: { kind: 'tool', globalAssetId: 'urn:a', key: 'T-7' }, refs: [{ system: 'sap-s4:PRD:100', type: 'equipment', id: '1' }] }]);
    const error = await store.putExternalRefs('pkg_a', doc).catch((e: unknown) => e);
    expect((error as ExternalRefConflictError).claims.map((claim) => claim.subject)).toEqual(['asset|urn:a', 'tool|urn:a|T-7']);
    await expect(store.putExternalRefs('pkg_a', refsDoc('urn:a', '1'), 5)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.putExternalRefs('pkg_missing', refsDoc('urn:x', '1'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('runtime state round-trip; forgetPackage removes config, refs, keys and package state but keeps events', async () => {
    const { store } = log();
    await store.putRuntimeState('dispatcher:cursor', { seq: 12 });
    await store.putRuntimeState('detector:pkg_a', { state: 'run' }, 'pkg_a');
    await expect(store.putRuntimeState('detector:pkg_missing', {}, 'pkg_missing')).rejects.toBeInstanceOf(NotFoundError);
    await store.putPackageIntegrationConfig('pkg_a', { s: 1 });
    await store.putExternalRefs('pkg_a', refsDoc('urn:a', '1'));
    await store.appendEvents([event('kept', { packageId: 'pkg_a' })]);
    expect(await store.getRuntimeState('dispatcher:cursor')).toEqual({ seq: 12 });

    store.forgetPackage('pkg_a');
    expect(await store.getRuntimeState('detector:pkg_a')).toBeUndefined();
    expect(await store.getRuntimeState('dispatcher:cursor')).toEqual({ seq: 12 });
    expect(await store.getPackageIntegrationConfig('pkg_a')).toBeUndefined();
    expect(await store.getExternalRefs('pkg_a')).toBeUndefined();
    expect(await store.findExternalRef('sap-s4:PRD:100', 'equipment', '1')).toEqual([]);
    expect((await store.readEvents({ after: 0, limit: 10 })).items.map((row) => row.id)).toEqual(['kept']);
  });

  it('snapshot survives JSON and restores everything, including the ref key index and the seq counter', async () => {
    const { store, time } = log();
    await store.appendEvents([event('e1', { packageId: 'pkg_a' })]);
    const sub = await store.createSubscription(subscription());
    await store.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 1, eventId: 'e1' }], time.now());
    await store.putServerIntegrationConfig({ a: 1 });
    await store.putExternalRefs('pkg_a', refsDoc('urn:a', '1'));
    await store.putRuntimeState('k', [1, 2], 'pkg_a');

    const restored = new MemoryIntegrationLog(ownerOf, { now: time.now });
    restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
    expect(await restored.readEvents({ after: 0, limit: 10 })).toEqual(await store.readEvents({ after: 0, limit: 10 }));
    expect(await restored.getSubscription(sub.id)).toEqual(await store.getSubscription(sub.id));
    expect(await restored.findExternalRef('sap-s4:PRD:100', 'equipment', '1')).toEqual([{ packageId: 'pkg_a', subject: 'asset|urn:a' }]);
    expect(await restored.getServerIntegrationConfig()).toEqual(await store.getServerIntegrationConfig());
    expect(await restored.getRuntimeState('k')).toEqual([1, 2]);
    expect((await restored.appendEvents([event('e2')]))[0]!.seq).toBe(2);
    expect(await restored.appendEvents([event('e1')])).toEqual([]); // id index rebuilt
    await restored.enqueueDeliveries([{ subscriptionId: sub.id, eventSeq: 2, eventId: 'e2' }], time.now());
    const ids = (await restored.listDeliveries(sub.id)).items.map((row) => row.id);
    expect(new Set(ids).size).toBe(2); // delivery id counter restored, no reuse
    restored.forgetPackage('pkg_a');
    expect(await restored.getRuntimeState('k')).toBeUndefined(); // package of a state row survives the round trip
  });
});

describe('change context', () => {
  it('runWithChange scopes cause and change set to the call, including awaited work', async () => {
    expect(currentChange()).toBeUndefined();
    const seen = await runWithChange({ cause: 'undo', changeSetId: 'chg_1' }, async () => {
      await Promise.resolve();
      const inner = runWithChange({ cause: 'external-refs' }, () => currentChange());
      return { outer: currentChange(), inner };
    });
    expect(seen).toEqual({ outer: { cause: 'undo', changeSetId: 'chg_1' }, inner: { cause: 'external-refs' } });
    expect(currentChange()).toBeUndefined();
    expect(runWithChange(undefined, () => currentChange())).toBeUndefined();
  });
});
