/**
 * 수집 주기 실행 — 기획서 M8.
 *
 * 현장에서 깨지는 방식이 정해져 있어서, 그 셋을 먼저 막고 시작한다.
 *  ① 장비 하나가 죽어도 나머지 수집은 계속돼야 한다 (인터페이스별 격리)
 *  ② 한 주기가 길어져도 다음 주기가 **겹쳐 돌면 안 된다** (중복 실행 방지)
 *  ③ 연결이 끊기면 다음 주기에 다시 붙는다 (실패한 연결은 버린다)
 *
 * 시계와 타이머를 주입받는다 — 시험이 실제 시간을 기다리지 않게 하기 위해서다.
 */
import type { AidInterface } from './aid.js';
import { collectOnce, type CollectReport } from './collect.js';
import type { ProtocolReader, SampleSink } from './types.js';

export interface CycleReport {
  startedAt: string;
  /** 이 주기에 쌓은 표본 수 */
  collected: number;
  /** 인터페이스별 결과 */
  interfaces: {
    name: string;
    report?: CollectReport;
    /** 접속 자체가 안 됐을 때 */
    error?: string;
  }[];
}

/**
 * 타이머 자리.
 *
 * `@types/node` 전역에 기대지 않는다 — 이 패키지는 순수 로직이라 어디서 돌든 같아야 하고,
 * 시험이 실제 시간을 기다리지 않으려면 어차피 주입할 수 있어야 한다(린터와 같은 원칙).
 */
export interface TimerHost {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers = globalThis as unknown as TimerHost;

export interface RunnerOptions {
  packageId: string;
  interfaces: readonly AidInterface[];
  /** 인터페이스마다 어떻게 붙을지 — 프로토콜 어댑터를 여기서 만든다 */
  openReader: (descriptor: AidInterface) => Promise<ProtocolReader>;
  sink: SampleSink;
  /** 주기(ms) */
  intervalMs: number;
  now?: () => string;
  onCycle?: (report: CycleReport) => void;
  /** 시험에서 시간을 손에 쥐기 위해 갈아 끼운다 */
  timers?: TimerHost;
}

export class CollectionRunner {
  private timer: unknown;
  private running = false;
  private stopped = false;
  /** 인터페이스 이름 → 살아 있는 연결 */
  private readonly readers = new Map<string, ProtocolReader>();

  private readonly timers: TimerHost;

  constructor(private readonly options: RunnerOptions) {
    this.timers = options.timers ?? systemTimers;
  }

  /** 지금 한 주기를 돈다. 이미 돌고 있으면 겹쳐 돌지 않는다 */
  async runOnce(): Promise<CycleReport> {
    const now = this.options.now ?? ((): string => new Date().toISOString());
    if (this.running) {
      return { startedAt: now(), collected: 0, interfaces: [] };
    }
    this.running = true;

    const cycle: CycleReport = { startedAt: now(), collected: 0, interfaces: [] };
    try {
      for (const descriptor of this.options.interfaces) {
        // 인터페이스 하나의 실패가 다른 인터페이스를 막지 않는다
        try {
          const reader = await this.readerFor(descriptor);
          const report = await collectOnce(descriptor, reader, this.options.sink, {
            packageId: this.options.packageId,
            ...(this.options.now ? { now: this.options.now } : {}),
          });
          cycle.collected += report.collected;
          cycle.interfaces.push({ name: descriptor.name, report });
        } catch (error) {
          // 연결이 상했을 수 있으니 버린다 — 다음 주기에 새로 붙는다
          await this.dropReader(descriptor.name);
          cycle.interfaces.push({
            name: descriptor.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }

    this.options.onCycle?.(cycle);
    return cycle;
  }

  /** 주기 실행을 시작한다. 첫 주기는 곧바로 돈다 */
  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await this.runOnce();
      if (this.stopped) return;
      // 주기 간격은 **끝난 뒤부터** 센다. 수집이 오래 걸려도 큐가 쌓이지 않는다
      this.timer = this.timers.setTimeout(() => void tick(), this.options.intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    for (const name of [...this.readers.keys()]) await this.dropReader(name);
  }

  private async readerFor(descriptor: AidInterface): Promise<ProtocolReader> {
    const existing = this.readers.get(descriptor.name);
    if (existing) return existing;
    const reader = await this.options.openReader(descriptor);
    this.readers.set(descriptor.name, reader);
    return reader;
  }

  private async dropReader(name: string): Promise<void> {
    const reader = this.readers.get(name);
    if (!reader) return;
    this.readers.delete(name);
    await reader.close().catch(() => undefined);
  }
}
