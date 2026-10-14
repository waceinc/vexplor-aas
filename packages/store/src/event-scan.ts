/**
 * Reading the event log in seq order with the outbox settle rule on the **unfiltered** sequence (design §2.4).
 *
 * Why here and not in the API: a filtered page (one type, one package, one workspace, audit hidden) has holes that
 * are not gaps at all. Settling a filtered page made every filtered reader wait 30 s on PostgreSQL behind rows it was
 * never going to see (live E2E, D5). The store sees the raw sequence, so it decides what is a gap, then filters.
 * Every store implementation feeds its raw rows through this one scanner — memory, folder and PostgreSQL behave alike.
 */
import { typesMatch } from '@aas/core';

import type { EventQuery, StoredEvent } from './integration-types.js';
import type { PackageScope } from './types.js';

export const AUDIT_TYPE = 'kr.vexplor.aas.integration.audit.v1';
/** At most this many raw rows are looked at per read, so a rare filter cannot make one read walk the whole log */
export const MAX_RAW_SCAN = 10_000;

/** Whether a row belongs in the page (everything except the settle rule) */
export function eventMatches(row: StoredEvent, query: EventQuery, scope?: PackageScope): boolean {
  if (!query.includeAudit && row.type === AUDIT_TYPE) return false;
  if (query.packageId !== undefined && row.packageId !== query.packageId) return false;
  if (scope !== undefined && row.owner !== undefined && row.owner !== scope.owner) return false;
  return typesMatch(query.types, row.type);
}

/** Feed raw rows in seq order; `push` answers false when the scan is complete */
export class EventScanner {
  readonly items: StoredEvent[] = [];
  frontier: number;
  private scanned = 0;
  private done = false;
  private readonly limit: number;
  private readonly nowMs: number | undefined;

  constructor(
    private readonly query: EventQuery,
    private readonly scope: PackageScope | undefined,
    limit: number,
    private readonly copy: (row: StoredEvent) => StoredEvent = (row) => row,
  ) {
    this.frontier = query.after;
    this.limit = limit;
    this.nowMs = query.settle ? Date.parse(query.settle.now) : undefined;
  }

  push(row: StoredEvent): boolean {
    if (this.done) return false;
    if (row.seq <= this.frontier) return true;
    // A missing seq before this row: an uncommitted (or rolled-back) transaction. Hold unless this row is old enough
    if (row.seq > this.frontier + 1 && this.query.settle && this.nowMs !== undefined) {
      const age = this.nowMs - Date.parse(row.recordedAt);
      if (!(age > this.query.settle.settleMs)) return this.stop();
    }
    this.frontier = row.seq;
    if (eventMatches(row, this.query, this.scope)) this.items.push(this.copy(row));
    this.scanned++;
    if (this.items.length >= this.limit || this.scanned >= MAX_RAW_SCAN) return this.stop();
    return true;
  }

  private stop(): boolean {
    this.done = true;
    return false;
  }
}
