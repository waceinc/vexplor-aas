/**
 * State segments of a package over a window — the server side of the daily state bar (docs/design/integration-v1.md §6.4).
 *
 * Important: computed with the **same core functions** the web bar uses (`normalizeState`, `stateTimeline`,
 *    `stateTotals`), on the same stored values with the same receive-time basis, so the API, the bar and the events
 *    agree. Unlike the detector, quality is not filtered here — the bar does not filter either, and the two must match.
 */
import { createHash } from 'node:crypto';
import { normalizeState, ruleSetHashInput, stateTimeline, stateTotals, type BarState, type Segment, type StateRules } from '@aas/core';
import type { AasStore, CollectedValue, ValueQuery } from '@aas/store';
import { sampleMs } from './counters.js';

/** `sha256:` + hex of the canonical rule text — two rule sets that judge every value alike hash alike */
export function ruleSetHash(rules: StateRules): string {
  return `sha256:${createHash('sha256').update(ruleSetHashInput(rules), 'utf8').digest('hex')}`;
}

const PAGE = 100_000;
/** A hard ceiling on one read so a 31-day window at 1 s polling cannot exhaust memory; reported as `truncated` */
export const MAX_VALUES = 1_000_000;

/**
 * Every stored value of one property in [from, to) by receive time, oldest first.
 * The store returns newest first with a limit, so this pages backwards by moving `to` to the oldest value seen.
 * Important: values sharing the oldest timestamp of a full page are re-read on the next page, not skipped — the page
 *    boundary uses that timestamp inclusively and duplicates are dropped by identity of (time, interface, source).
 */
export async function readWindow(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  query: Pick<ValueQuery, 'propertyName' | 'interfaceName'>,
  from: string,
  to: string,
  pageSize = PAGE,
): Promise<{ values: CollectedValue[]; truncated: boolean }> {
  const seen = new Set<string>();
  const out: CollectedValue[] = [];
  let upper = to;
  for (;;) {
    const page = await store.readValues(packageId, { ...query, from, to: upper, basis: 'received', limit: pageSize });
    let added = 0;
    for (const value of page) {
      const key = `${value.receivedAt ?? value.observedAt}|${value.observedAt}|${value.interfaceName}|${value.source ?? ''}|${value.valueText ?? ''}|${value.valueNumber ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      added += 1;
    }
    if (page.length < pageSize || added === 0) break;
    if (out.length >= MAX_VALUES) return { values: sortOldestFirst(out), truncated: true };
    const oldest = page[page.length - 1]!;
    // +1 ms keeps the boundary timestamp inside the next page (to is exclusive)
    upper = new Date(Date.parse(oldest.receivedAt ?? oldest.observedAt) + 1).toISOString();
  }
  return { values: sortOldestFirst(out), truncated: false };
}

function sortOldestFirst(values: CollectedValue[]): CollectedValue[] {
  return values.sort((a, b) => sampleMs(a) - sampleMs(b));
}

export interface SegmentResult {
  segments: Segment[];
  totals: Record<BarState, number>;
  truncated: boolean;
}

/** Segments and totals of the state property over [start, end) */
export async function computeSegments(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  state: { property: string; interfaceName: string | null },
  rules: StateRules,
  start: number,
  end: number,
  holdMs: number,
): Promise<SegmentResult> {
  const { values, truncated } = await readWindow(
    store,
    packageId,
    { propertyName: state.property, ...(state.interfaceName ? { interfaceName: state.interfaceName } : {}) },
    new Date(start - holdMs).toISOString(),
    new Date(end).toISOString(),
  );
  const samples = values.map((value) => ({ at: sampleMs(value), state: normalizeState(value, rules) }));
  const segments = stateTimeline(samples, start, end, holdMs);
  return { segments, totals: stateTotals(segments), truncated };
}
