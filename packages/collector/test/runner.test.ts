/**
 * Periodic run tests — checks that three field failure modes are handled.
 *  (1) One device dying does not stop collection from the others
 *  (2) A long cycle never overlaps the next
 *  (3) A broken connection is discarded and reconnected on the next cycle
 */
import {
  CollectionRunner,
  type AidInterface,
  type ProtocolReader,
  type TimerHost,
  type ValueSample,
} from '@aas/collector';
import { describe, expect, it } from 'vitest';

const iface = (name: string, href: string): AidInterface => ({
  name,
  protocol: 'OPCUA',
  base: `opc.tcp://${name}`,
  properties: [{ name: 'Speed', href, observable: true, formFields: {} }],
});

/** Manually advanced clock — does not wait for real time */
function manualTimers(): TimerHost & { fire(): Promise<void>; pending: number } {
  let handlers: (() => void)[] = [];
  return {
    setTimeout(handler) {
      handlers.push(handler);
      return handlers.length;
    },
    clearTimeout() {
      handlers = [];
    },
    get pending() {
      return handlers.length;
    },
    async fire() {
      const queued = handlers;
      handlers = [];
      for (const handler of queued) handler();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function sink(): { samples: ValueSample[]; append: (s: readonly ValueSample[]) => Promise<void> } {
  const samples: ValueSample[] = [];
  return { samples, append: async (batch) => void samples.push(...batch) };
}

describe('Periodic run', () => {
  it('collects every cycle', async () => {
    const timers = manualTimers();
    const target = sink();
    let reads = 0;
    const runner = new CollectionRunner({
      packageId: 'pkg_1',
      interfaces: [iface('A', 'ns=1;s=A')],
      openReader: async () => ({
        base: 'opc.tcp://A',
        read: async (sources) => {
          reads += 1;
          return sources.map((source) => ({ source, value: reads }));
        },
        close: async () => {},
      }),
      sink: target,
      intervalMs: 1000,
      timers,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.samples).toHaveLength(1); // first cycle runs immediately

    await timers.fire();
    expect(target.samples).toHaveLength(2);
    expect(target.samples[1]!.valueNumber).toBe(2);

    await runner.stop();
    expect(timers.pending).toBe(0);
  });

  it('keeps collecting from the others when one device dies', async () => {
    const target = sink();
    const runner = new CollectionRunner({
      packageId: 'pkg_1',
      interfaces: [iface('죽은장비', 'ns=1;s=X'), iface('산장비', 'ns=1;s=Y')],
      openReader: async (descriptor) => {
        if (descriptor.name === '죽은장비') throw new Error('접속 실패: 연결 거부');
        return {
          base: 'opc.tcp://산장비',
          read: async (sources) => sources.map((source) => ({ source, value: 7 })),
          close: async () => {},
        };
      },
      sink: target,
      intervalMs: 1000,
      timers: manualTimers(),
    });

    const cycle = await runner.runOnce();
    expect(cycle.collected).toBe(1);
    expect(cycle.interfaces[0]).toEqual({ name: '죽은장비', error: '접속 실패: 연결 거부' });
    expect(cycle.interfaces[1]!.report!.collected).toBe(1);
    await runner.stop();
  });

  it('does not overlap when a cycle runs long', async () => {
    const target = sink();
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = new CollectionRunner({
      packageId: 'pkg_1',
      interfaces: [iface('느린장비', 'ns=1;s=A')],
      openReader: async () => ({
        base: 'x',
        read: async (sources) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return sources.map((source) => ({ source, value: 1 }));
        },
        close: async () => {},
      }),
      sink: target,
      intervalMs: 1,
      timers: manualTimers(),
    });

    // call again before the previous cycle finishes
    const first = runner.runOnce();
    const second = await runner.runOnce();
    await first;

    expect(maxInFlight).toBe(1); // never overlaps
    expect(second.collected).toBe(0); // an overlapping call returns an empty cycle
    await runner.stop();
  });

  it('discards a broken connection and reconnects on the next cycle', async () => {
    const target = sink();
    let opened = 0;
    let closed = 0;
    let failNext = true;
    const runner = new CollectionRunner({
      packageId: 'pkg_1',
      interfaces: [iface('불안정', 'ns=1;s=A')],
      openReader: async () => {
        opened += 1;
        return {
          base: 'x',
          read: async (sources) => {
            if (failNext) {
              failNext = false;
              throw new Error('소켓 끊김');
            }
            return sources.map((source) => ({ source, value: 3 }));
          },
          close: async () => void (closed += 1),
        };
      },
      sink: target,
      intervalMs: 1000,
      timers: manualTimers(),
    });

    const bad = await runner.runOnce();
    expect(bad.interfaces[0]!.error).toContain('소켓 끊김');
    expect(closed).toBe(1); // the broken connection is closed

    const good = await runner.runOnce();
    expect(good.collected).toBe(1);
    expect(opened).toBe(2); // reconnected
    await runner.stop();
  });

  it('stops running and closes connections when stopped', async () => {
    const timers = manualTimers();
    let closed = 0;
    const target = sink();
    const runner = new CollectionRunner({
      packageId: 'pkg_1',
      interfaces: [iface('A', 'ns=1;s=A')],
      openReader: async () => ({
        base: 'x',
        read: async (sources) => sources.map((source) => ({ source, value: 1 })),
        close: async () => void (closed += 1),
      }),
      sink: target,
      intervalMs: 1000,
      timers,
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runner.stop();

    const before = target.samples.length;
    await timers.fire(); // a timer firing after stop does nothing
    expect(target.samples).toHaveLength(before);
    expect(closed).toBe(1);
  });
});
