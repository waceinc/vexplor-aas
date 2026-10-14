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
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { CollectionRunner, parseAid } from '@aas/collector';
import type { AasStore } from '@aas/store';

export interface SupervisorOptions {
  store: AasStore;
  openReader: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /** Interval (ms) */
  intervalMs: number;
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
    const startedAt = new Date().toISOString();
    const results: SweepPackageResult[] = [];

    try {
      let cursor: string | undefined;
      do {
        const page = await this.options.store.listPackages(cursor === undefined ? {} : { cursor });
        for (const record of page.items) {
          try {
            const environment = await this.options.store.getEnvironment(record.id);
            const interfaces = parseAid(environment);
            if (interfaces.length === 0) continue;

            const runner = new CollectionRunner({
              packageId: record.id,
              interfaces,
              openReader: this.options.openReader,
              sink: {
                append: (samples) => this.options.store.appendValues(record.id, samples),
              },
              intervalMs: 0,
            });
            try {
              const report = await runner.runOnce();
              results.push({
                packageId: record.id,
                ...(record.name === undefined ? {} : { name: record.name }),
                collected: report.collected,
                errors: report.interfaces
                  .filter((entry) => entry.error !== undefined)
                  .map((entry) => `${entry.name}: ${entry.error}`),
              });
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
      finishedAt: new Date().toISOString(),
      packages: results.length,
      collected: results.reduce((sum, entry) => sum + entry.collected, 0),
      results,
    };
    this.lastSweep = report;
    return report;
  }
}
