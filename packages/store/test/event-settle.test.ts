/**
 * Reading the event log with the settle rule on the unfiltered sequence (design §2.4, live E2E D5).
 *
 * Important: a filtered reader (one type, one package, another workspace, audit hidden) must not wait behind rows it
 *    is not shown — those are not gaps. Only a seq missing from the raw table (a transaction not committed yet, or
 *    rolled back) holds the read back, until the row after it is older than the settle time.
 */
import { PGlite } from '@electric-sql/pglite';
import { EventScanner, MemoryIntegrationLog, PostgresStore, type SqlClient, type StoredEvent } from '@aas/store';
import { describe, expect, it } from 'vitest';

const NOW = '2026-10-14T00:01:00.000Z';
const YOUNG = '2026-10-14T00:00:59.000Z';
const OLD = '2026-10-14T00:00:00.000Z';
const STATE = 'kr.vexplor.aas.equipment.state.changed.v1';
const ALARM = 'kr.vexplor.aas.equipment.alarm.raised.v1';
const AUDIT = 'kr.vexplor.aas.integration.audit.v1';
const settle = { now: NOW, settleMs: 30_000 };

const row = (seq: number, type = STATE, extra: Partial<StoredEvent> = {}): StoredEvent => ({
  seq, id: `e${seq}`, type, time: YOUNG, recordedAt: YOUNG, data: {}, ...extra,
});

function scan(rows: StoredEvent[], query: Partial<ConstructorParameters<typeof EventScanner>[0]>, scope?: { owner: string }, limit = 100) {
  const scanner = new EventScanner({ after: 0, limit, settle, ...query }, scope, limit);
  for (const item of rows) if (!scanner.push(item)) break;
  return { seqs: scanner.items.map((item) => item.seq), frontier: scanner.frontier };
}

describe('EventScanner', () => {
  it('rows filtered out (audit, other type, other package, other workspace) are not gaps', () => {
    const rows = [row(1, AUDIT), row(2, ALARM), row(3, STATE, { packageId: 'p2' }), row(4, STATE, { owner: 'user:b' }), row(5)];
    expect(scan(rows, { types: [STATE], packageId: undefined }, { owner: 'user:a' })).toEqual({ seqs: [3, 5], frontier: 5 });
    expect(scan(rows, { types: [ALARM] })).toEqual({ seqs: [2], frontier: 5 });
  });

  it('a missing seq holds the read while the row after it is young, passes once it is old', () => {
    expect(scan([row(1), row(3)], {})).toEqual({ seqs: [1], frontier: 1 });
    expect(scan([row(1), row(3, STATE, { recordedAt: OLD })], {})).toEqual({ seqs: [1, 3], frontier: 3 });
    expect(scan([row(1), row(3)], { settle: undefined })).toEqual({ seqs: [1, 3], frontier: 3 });
  });

  it('the frontier stops at the limit; `after` is respected', () => {
    expect(scan([row(1), row(2), row(3)], {}, undefined, 2)).toEqual({ seqs: [1, 2], frontier: 2 });
    expect(scan([row(1), row(2), row(3)], { after: 2 })).toEqual({ seqs: [3], frontier: 3 });
  });
});

describe('MemoryIntegrationLog: frontier past filtered rows', () => {
  it('a types-filtered read advances its cursor past non-matching rows', async () => {
    const log = new MemoryIntegrationLog(() => undefined, { now: () => YOUNG });
    await log.appendEvents([{ id: 'a', type: STATE, time: YOUNG, data: {} }, { id: 'b', type: ALARM, time: YOUNG, data: {} }, { id: 'c', type: STATE, time: YOUNG, data: {} }]);
    const page = await log.readEvents({ after: 0, limit: 100, types: [ALARM], settle });
    expect(page.items.map((item) => item.id)).toEqual(['b']);
    expect(page.frontier).toBe(3);
  });
});

function clientOf(db: PGlite): SqlClient {
  return {
    async query(text, params) {
      const result = await db.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
  };
}

describe('PostgresStore (PGlite)', () => {
  async function store() {
    const db = new PGlite();
    const pg = new PostgresStore(clientOf(db));
    await pg.init();
    return { db, pg };
  }
  const event = (id: string, type = STATE) => ({ id, type, time: YOUNG, data: {} });
  const fresh = () => ({ now: new Date(Date.now() + 1000).toISOString(), settleMs: 30_000 });

  it('Important: a reader without audit and a types-filtered reader get matching committed rows at once', async () => {
    const { pg } = await store();
    await pg.appendEvents([event('audit', AUDIT), event('state'), event('alarm', ALARM)]);
    const noAudit = await pg.readEvents({ after: 0, limit: 10, settle: fresh() });
    expect(noAudit.items.map((item) => item.id)).toEqual(['state', 'alarm']);
    expect(noAudit.frontier).toBe(3);
    const alarms = await pg.readEvents({ after: 0, limit: 10, types: [ALARM], settle: fresh() });
    expect(alarms.items.map((item) => item.id)).toEqual(['alarm']);
    expect(alarms.frontier).toBe(3);
  });

  it('a real gap (a rolled-back insert) still holds while the next row is young', async () => {
    const { db, pg } = await store();
    await pg.appendEvents([event('first')]);
    await db.exec(`BEGIN; INSERT INTO integration_event (id, type, occurred_at, data) VALUES ('gone', '${STATE}', now(), '{}'::jsonb); ROLLBACK;`);
    await pg.appendEvents([event('after-gap')]);
    const held = await pg.readEvents({ after: 0, limit: 10, settle: fresh() });
    expect(held.items.map((item) => item.id)).toEqual(['first']);
    expect(held.frontier).toBe(1);
    const later = await pg.readEvents({ after: 0, limit: 10, settle: { now: new Date(Date.now() + 31_000).toISOString(), settleMs: 30_000 } });
    expect(later.items.map((item) => item.id)).toEqual(['first', 'after-gap']);
  });
});
