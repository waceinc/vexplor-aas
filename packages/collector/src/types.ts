/**
 * Collection contract — spec M8.
 *
 * Important: value sync **Option A** (docs/PROGRESS.md §2-2) governs this design.
 * Collected values are **never written back into the model.** The output is a Type/Template, so writing
 * runtime values back violates metamodel semantics (KOSMO-AAS-6 · SM-4) and repeats the incident
 * Package Explorer ran into. So no function in this package modifies an Environment — it only reads.
 */

export interface ValueSample {
  /** Which file (unit of work) the asset belongs to */
  packageId: string;
  /** AID interface name */
  interfaceName: string;
  /** AID property name */
  propertyName: string;
  /** Address that was read (NodeId, etc.) — used later to trace the mapping back */
  source?: string;
  /** Observation time (ISO). Uses the device-supplied timestamp when available */
  observedAt: string;
  /**
   * The time this tool **actually read** the value (ISO). Added 2026-10-13.
   * Important: `observedAt` is the device-supplied time (OPC UA SourceTimestamp), so it moves **only when the value
   *    changes** — for a tag with a constant value the timestamp stays frozen in the past even though every read
   *    succeeds, so judging "receiving" from it makes a healthy tag look disconnected.
   *    We record the receive time separately per value (production lesson — in a digital-twin check all 271 rows had
   *    the same timestamp and "receiving" lost its meaning). Older records lack it — fall back to observedAt then.
   */
  receivedAt?: string;
  /** Here if it parses as a number, otherwise text */
  valueNumber?: number;
  valueText?: string;
  /** Quality (OPC UA StatusCode, etc.). Bad values are kept and flagged, not discarded */
  quality?: string;
  /**
   * Why the read failed — such a sample has no value (2.8.0). Stored so the screen can still say why after a reload or
   * an automatic cycle; Modbus and MQTT have no quality code that would carry it otherwise.
   */
  error?: string;
}

/** Shape that the one-shot reader side (protocol adapter) must satisfy */
export interface ProtocolReader {
  /** Endpoint address */
  readonly base: string;
  /** Reads a list of addresses in one call */
  read(sources: readonly string[]): Promise<ReadResult[]>;
  close(): Promise<void>;
}

export interface ReadResult {
  source: string;
  value: unknown;
  /** Device-supplied time. Filled in by the collector if absent */
  observedAt?: string;
  quality?: string;
  /** Reason when the read failed */
  error?: string;
  /**
   * Important: **no value has arrived yet** — this is not "the read failed".
   *
   * Our output is a Type/Template, so **empty values are normal** (PROGRESS §4 "OPC UA exposure", design item 5),
   * and equipment right after startup also reports "no value" statuses such as `BadWaitingForInitialData`.
   * Counting these together with faults makes healthy equipment show "60 bad tags", and novice users
   * read that as broken equipment. So it goes in a **separate field** from the reason (`error`).
   *
   * Important: pending is not a failure, but **not a success either.** The collector creates no sample —
   *    turning a missing value into an empty string and storing it in the time series leaves fake history from then on.
   */
  pending?: boolean;
}

/** Where collected values are stored — the time-series store */
export interface SampleSink {
  append(samples: readonly ValueSample[]): Promise<void>;
}
