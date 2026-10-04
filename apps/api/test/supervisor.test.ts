/**
 * 수집 감독 — 서버가 사람 없이 주기적으로 수집한다.
 *
 * 🔴 지키는 것 셋: ① AID 없는 파일은 건드리지 않는다 ② 파일 하나가 깨져도 나머지는 계속한다
 *    ③ 마지막 주기의 결과를 물어볼 수 있다("돌고는 있는 건가")
 */
import { readAasx } from '@aas/aasx';
import { CollectSupervisor } from '@aas/api';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

async function seeded() {
  const store = new InMemoryStore();
  await store.init();
  // AID 없는 파일 하나
  await store.importPackage({ name: '민짜.aasx', package: readAasx(goldenBytes) });
  // AID 있는 파일 하나
  const pkg = readAasx(goldenBytes);
  pkg.environment.submodels!.push(
    buildAidSubmodel({
      assetName: 'RollFormingMachine',
      iriBase: 'https://www.smart-factory.kr/ids',
      endpoint: 'opc.tcp://127.0.0.1:1',
      tags: [{ name: 'MotorSpeed', href: 'ns=1;s=Speed', type: 'float' }],
    }) as never,
  );
  const withAid = await store.importPackage({ name: '수집.aasx', package: pkg });
  return { store, withAid: withAid.id };
}

describe('수집 감독', () => {
  it('AID가 있는 파일만 수집하고, 결과를 들고 있는다', async () => {
    const { store, withAid } = await seeded();
    const supervisor = new CollectSupervisor({
      store,
      openReader: async (descriptor) => ({
        base: descriptor.base ?? '',
        read: async (sources) =>
          sources.map((source) => ({ source, value: 42, quality: 'Good' })),
        close: async () => {},
      }),
      intervalMs: 60_000,
    });

    const report = await supervisor.sweep();
    expect(report!.packages).toBe(1); // AID 없는 파일은 세지 않는다
    expect(report!.collected).toBe(1);
    expect(report!.results[0]!.packageId).toBe(withAid);

    // 시계열에 실제로 쌓였다
    const values = await store.readValues(withAid);
    expect(values).toHaveLength(1);
    expect(values[0]!.valueNumber).toBe(42);

    // 상태를 물어볼 수 있다
    const status = supervisor.status();
    expect(status.lastSweep?.collected).toBe(1);
    await supervisor.stop();
  });

  it('🔴 접속이 안 돼도 주기는 끝까지 돌고 사유를 남긴다', async () => {
    const { store } = await seeded();
    const supervisor = new CollectSupervisor({
      store,
      openReader: async () => {
        throw new Error('장비가 꺼져 있습니다');
      },
      intervalMs: 60_000,
    });

    const report = await supervisor.sweep();
    expect(report!.packages).toBe(1);
    expect(report!.collected).toBe(0);
    expect(report!.results[0]!.errors.join(' ')).toContain('장비가 꺼져');
    await supervisor.stop();
  });

  it('🔴 앞 주기가 도는 중이면 겹쳐 돌지 않는다', async () => {
    const { store } = await seeded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const supervisor = new CollectSupervisor({
      store,
      openReader: async (descriptor) => ({
        base: descriptor.base ?? '',
        read: async (sources) => {
          await gate; // 첫 주기를 붙잡아 둔다
          return sources.map((source) => ({ source, value: 1 }));
        },
        close: async () => {},
      }),
      intervalMs: 60_000,
    });

    const first = supervisor.sweep();
    const second = await supervisor.sweep(); // 겹침 — 건너뛰어야 한다
    expect(second).toBeUndefined();
    release();
    expect((await first)!.collected).toBe(1);
    await supervisor.stop();
  });
});
