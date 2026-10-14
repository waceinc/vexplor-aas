/**
 * The pull feed on a real PostgreSQL server (live E2E D5) — runs when DATABASE_URL is set, skipped otherwise.
 * A viewer and a types-filtered reader get committed rows at once; a held transaction still holds every reader.
 */
import { EVENT_TYPES } from '@aas/core';
import { PostgresStore, type SqlClient } from '@aas/store';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { ADMIN, routeCaller, testServices, VIEWER } from './helpers/integration-scenarios.js';

const url = process.env['DATABASE_URL'];

function poolClient(pool: pg.Pool): SqlClient {
  const run = (target: { query: pg.Pool['query'] }) => async (text: string, params?: readonly unknown[]) => ({
    rows: (await target.query(text, params as unknown[])).rows as never[],
  });
  return {
    query: run(pool),
    transaction: async (work) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const outcome = await work({ query: run(connection as unknown as pg.Pool) });
        await connection.query('COMMIT');
        return outcome;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

let counter = 0;
async function world() {
  const schema = `aas_feed_${Date.now()}_${counter++}`;
  const setup = new pg.Pool({ connectionString: url });
  await setup.query(`CREATE SCHEMA "${schema}"`);
  await setup.end();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const store = new PostgresStore(poolClient(pool));
  await store.init();
  const call = routeCaller(store, { demo: false, services: testServices({ storeKind: 'postgres' }) });
  return { pool, store, call };
}

const event = (id: string, type: string = EVENT_TYPES.equipmentStateChanged) => ({ id, type, time: '2026-10-14T00:00:00.000Z', data: {} });

describe.skipIf(!url)('pull feed on real PostgreSQL (D5)', () => {
  it('a viewer (no audit) and a types-filtered reader are not held behind rows they are not shown', async () => {
    const { pool, store, call } = await world();
    await store.appendEvents([event('audit', EVENT_TYPES.integrationAudit), event('shell', EVENT_TYPES.modelShellUpdated), event('state')]);
    expect((await call('GET', '/integrations/events', { principal: ADMIN })).body.items).toHaveLength(3);
    const viewer = await call('GET', '/integrations/events', { principal: VIEWER });
    expect(viewer.body.items.map((item: { id: string }) => item.id)).toEqual(['shell', 'state']);
    const filtered = await call('GET', '/integrations/events?types=equipment.*', { principal: VIEWER });
    expect(filtered.body.items.map((item: { id: string }) => item.id)).toEqual(['state']);
    expect(filtered.body.nextAfter).toBe('3');
    await pool.end();
  });

  it('a held transaction (uncommitted seq) still holds the feed for everyone until it commits', async () => {
    const { pool, store, call } = await world();
    await store.appendEvents([event('first')]);
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(`INSERT INTO integration_event (id, type, occurred_at, data) VALUES ('slow', '${EVENT_TYPES.equipmentStateChanged}', now(), '{}'::jsonb)`);
      await store.appendEvents([event('fast')]);
      const held = await call('GET', '/integrations/events?after=1', { principal: ADMIN });
      expect(held.body).toMatchObject({ items: [], nextAfter: '1' });
      await slow.query('COMMIT');
    } finally {
      slow.release();
    }
    const after = await call('GET', '/integrations/events?after=1', { principal: VIEWER });
    expect(after.body.items.map((item: { id: string }) => item.id)).toEqual(['slow', 'fast']);
    await pool.end();
  });
});
