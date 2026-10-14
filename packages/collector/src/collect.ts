/**
 * Collection execution — reads the addresses the AID describes and streams them into the time series.
 *
 * Does not depend on protocol implementations (node-opcua, etc.) directly; it only takes a `ProtocolReader` port.
 * Same reason the store only takes a `SqlClient` — this package is pure logic, so it must be
 * testable without equipment, and it should not add to the set of licenses to review.
 */
import { tr } from '@aas/core';
import type { AidInterface } from './aid.js';
import { readableProperties } from './aid.js';
import type { ProtocolReader, SampleSink, ValueSample } from './types.js';

export interface CollectOptions {
  packageId: string;
  /** Injects the clock — for deterministic use in tests */
  now?: () => string;
}

export interface CollectReport {
  /** Number of samples stored */
  collected: number;
  /** Items that could not be read — address and quality problems are not hidden */
  failures: { propertyName: string; source: string; reason: string }[];
  /**
   * Important: **no value has arrived yet** — not a failure (see `ReadResult.pending`).
   * Not written to the time series either. Reports "what has not arrived yet" but fabricates no value.
   *
   * Omitted entirely when empty. This report goes out as-is in the `/packages/:id/collect` response, and
   * to avoid breaking older consumers that only counted `failures`, the new field must appear unobtrusively.
   */
  pending?: { propertyName: string; source: string; reason: string }[];
  /** Items skipped because they have no address */
  skipped: string[];
}

/** Stores numeric values as numbers, otherwise as strings, because time-series queries differ between them */
export function toSample(
  base: Omit<ValueSample, 'valueNumber' | 'valueText'>,
  value: unknown,
): ValueSample {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ...base, valueNumber: value };
  }
  if (typeof value === 'boolean') return { ...base, valueNumber: value ? 1 : 0, valueText: String(value) };
  if (value === null || value === undefined) return { ...base, valueText: '' };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const parsed = Number(text);
  return Number.isFinite(parsed) && text.trim() !== ''
    ? { ...base, valueNumber: parsed, valueText: text }
    : { ...base, valueText: text };
}

export async function collectOnce(
  descriptor: AidInterface,
  reader: ProtocolReader,
  sink: SampleSink,
  options: CollectOptions,
): Promise<CollectReport> {
  const now = options.now ?? ((): string => new Date().toISOString());
  const readable = readableProperties(descriptor);
  const skipped = descriptor.properties
    .filter((property) => property.href === undefined)
    .map((property) => property.name);

  if (readable.length === 0) return { collected: 0, failures: [], skipped };

  const bySource = new Map(readable.map((property) => [property.href!, property]));
  const results = await reader.read([...bySource.keys()]);
  // Time of this read — identical for every value (read in one call). Basis for freshness checks (types.ts receivedAt)
  const receivedAt = now();

  const samples: ValueSample[] = [];
  const failures: CollectReport['failures'] = [];
  const pending: NonNullable<CollectReport['pending']> = [];

  for (const result of results) {
    const property = bySource.get(result.source);
    if (!property) continue;
    if (result.error !== undefined) {
      failures.push({ propertyName: property.name, source: result.source, reason: result.error });
      continue;
    }
    // Important: values not yet available are **not turned into samples.** `toSample(null)` leaves an empty string,
    //    which would store fake history saying "an empty value was observed at that time". Not counted as a failure either
    if (result.pending === true) {
      pending.push({
        propertyName: property.name,
        source: result.source,
        reason: result.quality ?? tr('값 대기'),
      });
      continue;
    }
    samples.push(
      toSample(
        {
          packageId: options.packageId,
          interfaceName: descriptor.name,
          propertyName: property.name,
          source: result.source,
          observedAt: result.observedAt ?? receivedAt,
          receivedAt,
          ...(result.quality === undefined ? {} : { quality: result.quality }),
        },
        result.value,
      ),
    );
  }

  if (samples.length > 0) await sink.append(samples);
  return {
    collected: samples.length,
    failures,
    ...(pending.length > 0 ? { pending } : {}),
    skipped,
  };
}
