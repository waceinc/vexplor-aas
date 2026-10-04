/**
 * 수집 감독 — 서버가 떠 있는 동안 주기적으로 알아서 수집한다.
 *
 * 왜 필요한가: 수집 엔진(CollectionRunner)은 있었지만 **서버가 그것을 켜는 자리가 없었다.**
 * 화면에서 「지금 수집」을 누를 때만 돌았다 — 운영이라면 사람이 없어도 돌아야 한다.
 *
 * 설계: 파일마다 러너를 상시로 쥐고 있지 않고, **주기마다 전체를 훑는다**(sweep).
 *  - 파일이 올라오거나 지워져도 다음 주기에 자연히 반영된다 — 러너 수명 관리가 없다
 *  - 한 주기가 밀려도 다음 주기와 **겹쳐 돌지 않는다** (진행 중이면 건너뛴다)
 *  - 장비 하나가 죽어도 나머지 파일 수집은 계속된다 (파일별 격리)
 *
 * 🔴 마지막 주기의 결과를 들고 있는다 — "돌고는 있는 건가"에 답할 수 있어야 한다.
 */
import type { AidInterface, ProtocolReader } from '@aas/collector';
import { CollectionRunner, parseAid } from '@aas/collector';
import type { AasStore } from '@aas/store';

export interface SupervisorOptions {
  store: AasStore;
  openReader: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /** 주기(ms) */
  intervalMs: number;
}

export interface SweepPackageResult {
  packageId: string;
  name?: string;
  /** 이 주기에 쌓은 표본 수 */
  collected: number;
  /** 인터페이스별 오류 (접속 실패 등) */
  errors: string[];
}

export interface SweepReport {
  startedAt: string;
  finishedAt: string;
  /** AID가 있는 파일 수 */
  packages: number;
  collected: number;
  results: SweepPackageResult[];
}

export interface SupervisorStatus {
  running: boolean;
  intervalMs: number;
  /** 아직 한 번도 안 돌았으면 없다 */
  lastSweep?: SweepReport;
  /** 지금 주기가 도는 중인가 */
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

  /** 한 바퀴 — 전체 파일을 훑어 AID가 있는 것만 수집한다 */
  async sweep(): Promise<SweepReport | undefined> {
    // 🔴 겹침 방지 — 앞 주기가 길어지면 이번 주기는 건너뛴다. 겹쳐 돌면 장비에 이중 접속한다
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
            // 🔴 파일 하나가 깨져도 나머지는 계속한다 — 사유는 남긴다
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
