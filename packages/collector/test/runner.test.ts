/**
 * 주기 실행 검증 — 현장에서 깨지는 방식 셋을 막았는지 본다.
 *  ① 장비 하나가 죽어도 나머지는 계속 수집
 *  ② 한 주기가 길어져도 겹쳐 돌지 않음
 *  ③ 연결이 상하면 버리고 다음 주기에 다시 붙음
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

/** 손으로 돌리는 시계 — 실제 시간을 기다리지 않는다 */
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

describe('주기 실행', () => {
  it('주기마다 수집한다', async () => {
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
    expect(target.samples).toHaveLength(1); // 첫 주기는 곧바로

    await timers.fire();
    expect(target.samples).toHaveLength(2);
    expect(target.samples[1]!.valueNumber).toBe(2);

    await runner.stop();
    expect(timers.pending).toBe(0);
  });

  it('장비 하나가 죽어도 나머지는 계속 수집한다', async () => {
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

  it('한 주기가 길어지면 겹쳐 돌지 않는다', async () => {
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

    // 앞 주기가 끝나기 전에 한 번 더 부른다
    const first = runner.runOnce();
    const second = await runner.runOnce();
    await first;

    expect(maxInFlight).toBe(1); // 절대 겹치지 않는다
    expect(second.collected).toBe(0); // 겹친 호출은 빈 주기로 돌아온다
    await runner.stop();
  });

  it('연결이 상하면 버리고 다음 주기에 다시 붙는다', async () => {
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
    expect(closed).toBe(1); // 상한 연결은 닫는다

    const good = await runner.runOnce();
    expect(good.collected).toBe(1);
    expect(opened).toBe(2); // 새로 붙었다
    await runner.stop();
  });

  it('멈추면 더 이상 돌지 않고 연결도 닫는다', async () => {
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
    await timers.fire(); // 멈춘 뒤의 타이머는 아무 일도 하지 않는다
    expect(target.samples).toHaveLength(before);
    expect(closed).toBe(1);
  });
});
