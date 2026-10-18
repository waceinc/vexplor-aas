/**
 * Batches the server took and refused in the last hour (2.8.0) — for the admin's server status, not a record.
 *
 * Important: in memory, per minute, the last 60 minutes only. A restart starts from zero; the screen says "since the
 *    server started" when it ran for less than an hour.
 */
const MINUTE = 60_000;
const KEEP = 60;

interface Minute {
  minute: number;
  batches: number;
  refused: number;
  samplesRejected: number;
}

export interface EdgeTrafficHour {
  /** Batches answered 2xx (duplicates included — the edge sent them and got an answer) */
  batches: number;
  /** Batch requests answered with an error (4xx, 5xx) */
  refused: number;
  /** Values inside accepted batches that were not stored (unknown tag, wrong type, …) */
  samplesRejected: number;
}

export class EdgeTraffic {
  private readonly minutes: Minute[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** One answer to POST /edge/v1/batches */
  record(status: number, body: unknown): void {
    const minute = Math.floor(this.now() / MINUTE);
    let slot = this.minutes.at(-1);
    if (slot?.minute !== minute) {
      slot = { minute, batches: 0, refused: 0, samplesRejected: 0 };
      this.minutes.push(slot);
      while (this.minutes.length > 0 && this.minutes[0]!.minute <= minute - KEEP) this.minutes.shift();
    }
    if (status >= 200 && status < 300) {
      slot.batches += 1;
      const rejected = (body as { rejected?: unknown } | undefined)?.rejected;
      if (Array.isArray(rejected)) slot.samplesRejected += rejected.length;
    } else slot.refused += 1;
  }

  lastHour(): EdgeTrafficHour {
    const from = Math.floor(this.now() / MINUTE) - KEEP;
    const recent = this.minutes.filter((slot) => slot.minute > from);
    return {
      batches: recent.reduce((sum, slot) => sum + slot.batches, 0),
      refused: recent.reduce((sum, slot) => sum + slot.refused, 0),
      samplesRejected: recent.reduce((sum, slot) => sum + slot.samplesRejected, 0),
    };
  }
}
