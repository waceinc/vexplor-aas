/**
 * Sends the queue in order, following the contract's error table (docs/edge-contract.md §6).
 *
 *   2xx                      → delete
 *   400 · 413 · 422          → refused/, next batch (413: the edge keeps batches under the limit, so this is a bug report)
 *   401 ClockSkew · 429 · 5xx · no answer → stop this round; resend the **same** batch later (backoff or Retry-After)
 *   401 other · 403          → stop sending altogether, keep the queue, alarm. Never re-register by itself
 *   anything else (404, 405 …) → like 5xx: wait and try again, logged
 *
 * Important: only what the contract names stops the edge. An answer it does not name comes from something between —
 *    a proxy, a server being upgraded, another program on the address — and stopping on it left a factory collector
 *    stopped for good after one 404 (site test, 2026-10-17).
 *
 * Important: one round never sleeps. It returns when it must wait, with the time to wait — the agent keeps reading
 *    equipment meanwhile, so an outage costs no samples, only queue space.
 */
import type { EdgeHttp, Signer } from './http.js';
import type { DiskQueue } from './queue.js';

export type FlushResult =
  | { state: 'idle'; sent: number; readListRevision?: string }
  | { state: 'wait'; sent: number; waitMs: number; reason: string; readListRevision?: string }
  | { state: 'stopped'; sent: number; reason: string };

const MAX_BACKOFF_MS = 300_000;

export class Sender {
  private failures = 0;
  private running: Promise<FlushResult> | undefined;
  stats = { sent: 0, accepted: 0, rejectedSamples: 0, duplicates: 0, refused: 0 };

  constructor(
    private readonly http: EdgeHttp,
    private readonly queue: DiskQueue,
    private readonly signer: () => Signer,
    private readonly random: () => number = Math.random,
  ) {}

  /** Backoff after `failures` failed rounds: 1 s doubling to 5 min, ±20 % */
  backoffMs(): number {
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  /**
   * One round at a time: a flush asked for while one runs waits for it instead of starting a second — two rounds at once
   * could send a realtime batch before the backlog, and the receiver would file the backlog as late (Logic Studio's
   * request, 2026-10-16; overlapping flushes were measured before this guard).
   */
  flush(): Promise<FlushResult> {
    this.running ??= this.round().finally(() => (this.running = undefined));
    return this.running;
  }

  private async round(): Promise<FlushResult> {
    let sent = 0;
    let readListRevision: string | undefined;
    for (const name of this.queue.files()) {
      const batch = this.queue.read(name);
      let answer;
      try {
        answer = await this.http.request(this.signer(), 'POST', '/edge/v1/batches', batch);
      } catch (error) {
        this.failures += 1;
        return { state: 'wait', sent, waitMs: this.backoffMs(), reason: `no answer: ${(error as Error).message}`, ...(readListRevision ? { readListRevision } : {}) };
      }
      const body = answer.body as { code?: string; accepted?: number; rejected?: unknown[]; duplicate?: boolean; readListRevision?: string } | undefined;
      if (answer.status >= 200 && answer.status < 300) {
        this.queue.done(name);
        this.failures = 0;
        sent += 1;
        this.stats.sent += 1;
        this.stats.accepted += body?.accepted ?? 0;
        this.stats.rejectedSamples += body?.rejected?.length ?? 0;
        if (body?.duplicate) this.stats.duplicates += 1;
        if (body?.readListRevision) readListRevision = body.readListRevision;
        continue;
      }
      if ([400, 413, 422].includes(answer.status)) {
        this.queue.refuse(name);
        this.stats.refused += 1;
        continue;
      }
      const stops = answer.status === 403 || (answer.status === 401 && body?.code !== 'ClockSkew');
      if (!stops) {
        this.failures += 1;
        const retryAfter = Number(answer.headers['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs();
        return { state: 'wait', sent, waitMs, reason: `${answer.status} ${body?.code ?? ''}`.trim(), ...(readListRevision ? { readListRevision } : {}) };
      }
      return { state: 'stopped', sent, reason: `${answer.status} ${body?.code ?? ''}`.trim() };
    }
    return { state: 'idle', sent, ...(readListRevision ? { readListRevision } : {}) };
  }
}
