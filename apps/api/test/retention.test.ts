/**
 * Collected value retention — deletes only expired values, on a set interval, without touching the model.
 * Per-store deletion itself is covered by the @aas/store conformance tests. Here only env var parsing and the interval are checked.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@aas/store';
import { readAasx } from '@aas/aasx';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { retentionDaysFromEnv, startRetention } from '../src/retention.js';

const golden = () =>
  readAasx(readFileSync(fileURLToPath(new URL('../../../tests/fixtures/01-롤포밍기-공34.aasx', import.meta.url))));

describe('COLLECT_RETENTION_DAYS', () => {
  it('missing, 0, negative, or text means off (0); positive is used as is — decimals accepted', () => {
    expect(retentionDaysFromEnv({})).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '0' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '-3' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '많이' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '180' })).toBe(180);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '0.5' })).toBe(0.5);
  });

  it('deletes only expired values and runs again every interval', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      await store.init();
      const { id } = await store.importPackage({ name: 'g.aasx', package: golden() });
      const at = (iso: string) => ({ packageId: id, interfaceName: 'I', propertyName: 'P', observedAt: iso, valueNumber: 1 });
      await store.appendValues(id, [
        at('2026-01-01T00:00:00.000Z'), // 245 days ago — deleted
        at('2026-08-01T00:00:00.000Z'), // 33 days ago — kept
      ]);
      const revision = (await store.getPackage(id))!.revision;

      let clock = Date.parse('2026-09-03T00:00:00.000Z');
      const handle = startRetention(store, 180, { sweepMs: 1000, now: () => clock });
      expect(await handle.pruneNow()).toBe(1);
      expect(await store.readValues(id)).toHaveLength(1);
      expect((await store.getPackage(id))!.revision).toBe(revision);

      // Moving the clock 200 days ahead and passing one interval makes the remaining value expire and disappear too
      clock += 200 * 24 * 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await store.readValues(id)).toHaveLength(0);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('0 does nothing', async () => {
    const store = new InMemoryStore();
    const handle = startRetention(store, 0);
    expect(await handle.pruneNow()).toBe(0);
    handle.stop();
  });
});
