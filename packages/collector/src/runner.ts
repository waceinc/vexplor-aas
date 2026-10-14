/**
 * Periodic collection runner — spec M8.
 *
 * Field failures follow known patterns, so we guard against these three up front.
 *  ① If one device dies, collection from the rest must continue (per-interface isolation)
 *  ② Even if one cycle runs long, the next cycle **must not overlap** it (no concurrent runs)
 *  ③ If a connection drops, reconnect on the next cycle (failed connections are discarded)
 *
 * The clock and timers are injected — so tests do not wait on real time.
 */
import type { AidInterface } from './aid.js';
import { collectOnce, type CollectReport } from './collect.js';
import type { ProtocolReader, SampleSink } from './types.js';

export interface CycleReport {
  startedAt: string;
  /** Number of samples stored in this cycle */
  collected: number;
  /** Per-interface results */
  interfaces: {
    name: string;
    report?: CollectReport;
    /** When the connection itself failed */
    error?: string;
  }[];
}

/**
 * Timer slot.
 *
 * Does not rely on `@types/node` globals — this package is pure logic and must behave the same wherever it runs,
 * and for tests not to wait on real time it has to be injectable anyway (same principle as the linter).
 */
export interface TimerHost {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers = globalThis as unknown as TimerHost;

export interface RunnerOptions {
  packageId: string;
  interfaces: readonly AidInterface[];
  /** How to connect per interface — protocol adapters are created here */
  openReader: (descriptor: AidInterface) => Promise<ProtocolReader>;
  sink: SampleSink;
  /** Interval (ms) */
  intervalMs: number;
  now?: () => string;
  onCycle?: (report: CycleReport) => void;
  /** Swapped out in tests to take control of time */
  timers?: TimerHost;
}

export class CollectionRunner {
  private timer: unknown;
  private running = false;
  private stopped = false;
  /** Interface name → live connection */
  private readonly readers = new Map<string, ProtocolReader>();

  private readonly timers: TimerHost;

  constructor(private readonly options: RunnerOptions) {
    this.timers = options.timers ?? systemTimers;
  }

  /** Runs one cycle now. If one is already running, does not overlap it */
  async runOnce(): Promise<CycleReport> {
    const now = this.options.now ?? ((): string => new Date().toISOString());
    if (this.running) {
      return { startedAt: now(), collected: 0, interfaces: [] };
    }
    this.running = true;

    const cycle: CycleReport = { startedAt: now(), collected: 0, interfaces: [] };
    try {
      for (const descriptor of this.options.interfaces) {
        // A failure in one interface does not block the others
        try {
          const reader = await this.readerFor(descriptor);
          const report = await collectOnce(descriptor, reader, this.options.sink, {
            packageId: this.options.packageId,
            ...(this.options.now ? { now: this.options.now } : {}),
          });
          cycle.collected += report.collected;
          cycle.interfaces.push({ name: descriptor.name, report });
        } catch (error) {
          // The connection may be broken, so discard it — reconnect fresh on the next cycle
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

  /** Starts periodic execution. The first cycle runs immediately */
  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await this.runOnce();
      if (this.stopped) return;
      // The interval is measured **from the end** of a cycle. Slow collection does not pile up a queue
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
