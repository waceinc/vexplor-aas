/**
 * Collection supervisor — the server collects periodically without a person.
 *
 * Important: three things guarded: 1. files without an AID are left alone 2. if one file breaks the rest keep going
 *    3. the result of the last cycle can be queried ("is it actually running?")
 */
import { readAasx } from '@aas/aasx';
import { CollectSupervisor } from '@aas/api';
import { buildAidSubmodel } from '@aas/collector';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

async function seeded() {
  const store = new InMemoryStore();
  await store.init();
  // One file without an AID
  await store.importPackage({ name: '민짜.aasx', package: readAasx(goldenBytes) });
  // One file with an AID
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

describe('collection supervisor', () => {
  it('collects only files with an AID and keeps the result', async () => {
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
    expect(report!.packages).toBe(1); // files without an AID are not counted
    expect(report!.collected).toBe(1);
    expect(report!.results[0]!.packageId).toBe(withAid);

    // Values actually accumulated in the time series
    const values = await store.readValues(withAid);
    expect(values).toHaveLength(1);
    expect(values[0]!.valueNumber).toBe(42);

    // The status can be queried
    const status = supervisor.status();
    expect(status.lastSweep?.collected).toBe(1);
    await supervisor.stop();
  });

  it('Important: even when the connection fails, the cycle runs to the end and records the reason', async () => {
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

  it('Important: does not overlap while the previous cycle is still running', async () => {
    const { store } = await seeded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const supervisor = new CollectSupervisor({
      store,
      openReader: async (descriptor) => ({
        base: descriptor.base ?? '',
        read: async (sources) => {
          await gate; // hold the first cycle
          return sources.map((source) => ({ source, value: 1 }));
        },
        close: async () => {},
      }),
      intervalMs: 60_000,
    });

    const first = supervisor.sweep();
    const second = await supervisor.sweep(); // overlap — must be skipped
    expect(second).toBeUndefined();
    release();
    expect((await first)!.collected).toBe(1);
    await supervisor.stop();
  });
});
