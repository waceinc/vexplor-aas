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

const PAGE = 50_000;
/**
 * Most values one request may load (review M6). 200 000 rows is a 31-day window of one tag polled every ~13 s; a finer
 * poll over a long window is refused with a clear message instead of exhausting the server's memory.
 */
export const MAX_VALUES = 200_000;

/** More stored values than one request may load — the API answers 422 and asks for a shorter window */
export class ValueLimitError extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} values in the window`);
    this.name = 'ValueLimitError';
  }
}

/**
 * Every stored value of one property in [from, to) by receive time, oldest first.
 * The store returns newest first with a limit, so this pages backwards by moving `to` to the oldest value seen.
 * Important: values sharing the oldest timestamp of a full page are re-read on the next page, not skipped — the page
 *    boundary uses that timestamp inclusively and duplicates are dropped by identity of (time, interface, source).
 * @throws ValueLimitError beyond `maxValues`
 */
export async function readWindow(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  query: Pick<ValueQuery, 'propertyName' | 'interfaceName'>,
  from: string,
  to: string,
  pageSize = PAGE,
  maxValues = MAX_VALUES,
): Promise<CollectedValue[]> {
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
    if (out.length > maxValues) throw new ValueLimitError(maxValues);
    if (page.length < pageSize || added === 0) break;
    const oldest = page[page.length - 1]!;
    // +1 ms keeps the boundary timestamp inside the next page (to is exclusive)
    upper = new Date(Date.parse(oldest.receivedAt ?? oldest.observedAt) + 1).toISOString();
  }
  return out.sort((a, b) => sampleMs(a) - sampleMs(b));
}

/** First index whose time is >= `at` in a list sorted oldest first */
export function lowerBound(values: readonly { at: number }[], at: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]!.at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SegmentResult {
  segments: Segment[];
  totals: Record<BarState, number>;
}

/** Judged state samples, oldest first — computed once, then sliced per window */
export type StateSamples = { at: number; state: ReturnType<typeof normalizeState> }[];

/** Reads the state property once for [start − holdMs, end) and judges every value */
export async function readStateSamples(
  store: Pick<AasStore, 'readValues'>,
  packageId: string,
  state: { property: string; interfaceName: string | null },
  rules: StateRules,
  start: number,
  end: number,
  holdMs: number,
): Promise<StateSamples> {
  const values = await readWindow(
    store,
    packageId,
    { propertyName: state.property, ...(state.interfaceName ? { interfaceName: state.interfaceName } : {}) },
    new Date(start - holdMs).toISOString(),
    new Date(end).toISOString(),
  );
  return values.map((value) => ({ at: sampleMs(value), state: normalizeState(value, rules) }));
}

/** Segments of [start, end) from judged samples — only the slice that can reach the window is looked at */
export function segmentsOf(samples: StateSamples, start: number, end: number, holdMs: number): SegmentResult {
  const slice = samples.slice(lowerBound(samples, start - holdMs), lowerBound(samples, end));
  const segments = stateTimeline(slice, start, end, holdMs);
  return { segments, totals: stateTotals(segments) };
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
  return segmentsOf(await readStateSamples(store, packageId, state, rules, start, end, holdMs), start, end, holdMs);
}
