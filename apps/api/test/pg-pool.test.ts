/**
 * Connections to PostgreSQL (2.8.1): the pool size comes from PG_POOL_MAX, default 10 — the pg default the server used
 * before. A value that is not a whole number from 1 to 1,000 falls back to the default instead of stopping the start.
 */
import { describe, expect, it } from 'vitest';
import { poolMaxFromEnv } from '../src/pg.js';

describe('PG_POOL_MAX', () => {
  it('sets the number of connections, 10 when not given', () => {
    expect(poolMaxFromEnv({})).toBe(10);
    expect(poolMaxFromEnv({ PG_POOL_MAX: '' })).toBe(10);
    expect(poolMaxFromEnv({ PG_POOL_MAX: '25' })).toBe(25);
    expect(poolMaxFromEnv({ PG_POOL_MAX: ' 4 ' })).toBe(4);
  });

  it('falls back to 10 for a value that is not a whole number from 1 to 1,000', () => {
    for (const bad of ['0', '-3', '2.5', 'many', '1001']) expect(poolMaxFromEnv({ PG_POOL_MAX: bad })).toBe(10);
  });
});
