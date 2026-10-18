/**
 * Collection supervisor — collects automatically at intervals while the server is up.
 *
 * Why it is needed: the collection engine (CollectionRunner) existed, but **the server had no place that started it.**
 * It ran only when "Collect now" was pressed in the UI — in operation it must run even with nobody around.
 *
 * Design: instead of holding a runner per file permanently, **sweep everything each cycle**.
 *  - Uploaded or deleted files are picked up naturally on the next cycle — no runner lifecycle management
 *  - If a cycle runs late, it **does not overlap** with the next one (skipped while one is in progress)
 *  - If one device dies, collection for the remaining files continues (per-file isolation)
 *
 * Important: keep the result of the last cycle — we must be able to answer "is it actually running?".
 */
import type { AidInterface, CycleReport, ProtocolReader, ValueSample } from '@aas/collector';
import { CollectionRunner, parseAid, statedIntervalMs } from '@aas/collector';
import type { Environment } from '@aas/core';
import type { AasStore, PackageRecord } from '@aas/store';

/**
 * One package's collection cycle, handed to the integration detector (docs/design/integration-v1.md §6.2).
 * `samples` are exactly what the sink stored in this cycle — the detector judges the same values the time series holds.
 */
export interface PackageCycle {
  record: PackageRecord;
  environment: Environment;
  interfaces: readonly AidInterface[];
  cycle: CycleReport;
  samples: readonly ValueSample[];
  startedAt: string;
  finishedAt: string;
  intervalMs: number;
}

export interface SupervisorOptions {
  store: AasStore;
  openReader: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /** Interval (ms) */
  intervalMs: number;
  /**
   * Called after each package cycle that ran (integration detector).
   * Important: its failure is recorded in that package's `errors` as `integration: …` and never breaks collection —
   *    a broken event pipeline must not stop the time series from filling.
   */
  onPackageCycle?: (cycle: PackageCycle) => Promise<void>;
  /** Clock (ISO) for cycle and sample times — injected by tests */
  now?: () => string;
}

export interface SweepPackageResult {
  packageId: string;
  name?: string;
  /** Number of samples stored in this cycle */
  collected: number;
  /** Errors per interface (connection failures, etc.) */
  errors: string[];
}

export interface SweepReport {
  startedAt: string;
  finishedAt: string;
  /** Number of files with an AID */
  packages: number;
  collected: number;
  results: SweepPackageResult[];
}

export interface SupervisorStatus {
  running: boolean;
  intervalMs: number;
  /** Absent if it has never run */
  lastSweep?: SweepReport;
  /** Whether a cycle is currently running */
  sweeping: boolean;
}

export class CollectSupervisor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sweeping = false;
  private stopped = false;
  private lastSweep: SweepReport | undefined;
  /** When each interface (package \0 interface) was last read — for a read period the AID states (2.8.0) */
  private readonly lastRead = new Map<string, number>();
  /** Each package's last result — repeated while none of its interfaces is due, so the screen keeps "connected (auto)" */
  private readonly lastResult = new Map<string, SweepPackageResult>();

  constructor(private readonly options: SupervisorOptions) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  status(): SupervisorStatus {
    return {
      running: !this.stopped,
      intervalMs: this.options.intervalMs,
      sweeping: this.sweeping,
      ...(this.lastSweep ? { lastSweep: this.lastSweep } : {}),
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweep().finally(() => this.schedule());
    }, this.options.intervalMs);
  }

  /** One sweep — scan all files and collect only those with an AID */
  async sweep(): Promise<SweepReport | undefined> {
    // Important: overlap guard — if the previous cycle runs long, skip this one. Overlapping would connect to devices twice
    if (this.sweeping) return undefined;
    this.sweeping = true;
    const now = this.options.now ?? ((): string => new Date().toISOString());
    const startedAt = now();
    const results: SweepPackageResult[] = [];

    try {
      let cursor: string | undefined;
      do {
        const page = await this.options.store.listPackages(cursor === undefined ? {} : { cursor });
        for (const record of page.items) {
          try {
            const environment = await this.options.store.getEnvironment(record.id);
            const all = parseAid(environment);
            if (all.length === 0) continue;
            /*
             * Important: a read period the AID states (2.8.0) is honoured at the sweep's own step — an interface is read
             *    when that long has passed since its last read, never more often. A period shorter than the sweep cannot
             *    be met here (the edge can); it is read every sweep, as before.
             */
            const nowMs = Date.parse(now());
            const interfaces = all.filter((descriptor) => {
              const stated = statedIntervalMs(descriptor);
              const last = this.lastRead.get(`${record.id}\0${descriptor.name}`);
              return stated === undefined || stated <= this.options.intervalMs || last === undefined || nowMs - last >= stated - 250;
            });
            if (interfaces.length === 0) {
              const kept = this.lastResult.get(record.id);
              results.push(kept ?? { packageId: record.id, ...(record.name === undefined ? {} : { name: record.name }), collected: 0, errors: [] });
              continue;
            }
            for (const descriptor of interfaces) this.lastRead.set(`${record.id}\0${descriptor.name}`, nowMs);
            const statedMax = Math.max(this.options.intervalMs, ...interfaces.map((descriptor) => statedIntervalMs(descriptor) ?? 0));

            // What the sink stored this cycle — only kept when someone listens
            const stored: ValueSample[] = [];
            const listening = this.options.onPackageCycle !== undefined;
            const runner = new CollectionRunner({
              packageId: record.id,
              interfaces,
              openReader: this.options.openReader,
              sink: {
                append: async (samples) => {
                  await this.options.store.appendValues(record.id, samples);
                  // Only after the store accepted them — the detector must never judge values the time series lacks.
                  // A failed read (no value, only its reason — 2.8.0) is not a value to judge
                  if (listening) stored.push(...samples.filter((sample) => sample.error === undefined));
                },
              },
              intervalMs: 0,
              ...(this.options.now ? { now: this.options.now } : {}),
            });
            try {
              const cycleStart = now();
              const report = await runner.runOnce();
              const errors = report.interfaces
                .filter((entry) => entry.error !== undefined)
                .map((entry) => `${entry.name}: ${entry.error}`);
              if (this.options.onPackageCycle) {
                try {
                  await this.options.onPackageCycle({
                    record,
                    environment,
                    interfaces,
                    cycle: report,
                    samples: stored,
                    startedAt: cycleStart,
                    finishedAt: now(),
                    // The period these values really arrive at — the detector's freshness window follows it
                    intervalMs: statedMax,
                  });
                } catch (error) {
                  errors.push(`integration: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
              const result = {
                packageId: record.id,
                ...(record.name === undefined ? {} : { name: record.name }),
                collected: report.collected,
                errors,
              };
              this.lastResult.set(record.id, result);
              results.push(result);
            } finally {
              await runner.stop();
            }
          } catch (error) {
            // Important: keep going even if one file is broken — record the reason
            results.push({
              packageId: record.id,
              ...(record.name === undefined ? {} : { name: record.name }),
              collected: 0,
              errors: [error instanceof Error ? error.message : String(error)],
            });
          }
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
    } finally {
      this.sweeping = false;
    }

    const report: SweepReport = {
      startedAt,
      finishedAt: now(),
      packages: results.length,
      collected: results.reduce((sum, entry) => sum + entry.collected, 0),
      results,
    };
    this.lastSweep = report;
    return report;
  }
}
