/**
 * 수집값 보존 기간 — 기간이 지난 것만, 정한 주기로, 모델은 건드리지 않고 지운다.
 * 저장소별 삭제 자체는 @aas/store 적합성 시험이 본다. 여기서는 환경 변수 해석과 주기만 본다.
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
  it('없거나 0·음수·글자면 끄기(0), 양수면 그대로 — 소수도 받는다', () => {
    expect(retentionDaysFromEnv({})).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '0' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '-3' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '많이' })).toBe(0);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '180' })).toBe(180);
    expect(retentionDaysFromEnv({ COLLECT_RETENTION_DAYS: '0.5' })).toBe(0.5);
  });

  it('기간이 지난 값만 지우고, 정한 주기마다 다시 돈다', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      await store.init();
      const { id } = await store.importPackage({ name: 'g.aasx', package: golden() });
      const at = (iso: string) => ({ packageId: id, interfaceName: 'I', propertyName: 'P', observedAt: iso, valueNumber: 1 });
      await store.appendValues(id, [
        at('2026-01-01T00:00:00.000Z'), // 245일 전 — 지워진다
        at('2026-08-01T00:00:00.000Z'), // 33일 전 — 남는다
      ]);
      const revision = (await store.getPackage(id))!.revision;

      let clock = Date.parse('2026-09-03T00:00:00.000Z');
      const handle = startRetention(store, 180, { sweepMs: 1000, now: () => clock });
      expect(await handle.pruneNow()).toBe(1);
      expect(await store.readValues(id)).toHaveLength(1);
      expect((await store.getPackage(id))!.revision).toBe(revision);

      // 시계를 200일 뒤로 돌리고 한 주기를 지나면 남은 것도 기간을 넘겨 사라진다
      clock += 200 * 24 * 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await store.readValues(id)).toHaveLength(0);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('0이면 아무것도 하지 않는다', async () => {
    const store = new InMemoryStore();
    const handle = startRetention(store, 0);
    expect(await handle.pruneNow()).toBe(0);
    handle.stop();
  });
});
