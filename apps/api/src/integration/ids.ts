/**
 * Identifiers and small shared helpers of the integration layer (docs/design/integration-v1.md §2, §6.3, D6).
 *
 * Why deterministic ids for runtime and projection events: after a crash the same cycle is processed again. If the
 * ids came from a random source, the receiver would get every event of that cycle twice. With the id derived from
 * what happened (type, subject, key, time, value), the second pass produces the same ids and the store skips them.
 * Model events use random UUIDs instead — every commit is a new fact.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32 — no I, L, O, U, so ids survive being read aloud or typed from a screenshot */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 26 base32 chars = 130 bits, more than enough against accidental collision */
const ID_CHARS = 26;

/** Crockford base32 of the bytes, unpadded, most significant bit first */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

function hashId(prefix: string, input: string): string {
  return prefix + base32Encode(createHash('sha256').update(input, 'utf8').digest()).slice(0, ID_CHARS);
}

/**
 * JSON with sorted object keys — two equal values always give the same text, whatever order their keys were built in.
 * `undefined` members are dropped (as JSON.stringify does), so `{ a: 1, b: undefined }` equals `{ a: 1 }`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * Id of a runtime or projection event: `evt_` + 26 base32 chars of sha256 over (type, subject, key, occurredAt, value).
 * `subject` = globalAssetId, or the package id when the package has none; `key` = rule / counter / interface id.
 * Important: never put receive-time or attempt data into `value` — a re-processed cycle must hash to the same id.
 */
export function eventIdFor(type: string, subject: string, key: string, occurredAt: string, value: unknown): string {
  return hashId('evt_', canonicalJson([type, subject, key, occurredAt, value]));
}

/** `alm_` + 26 base32 of sha256(globalAssetId|ruleId|raisedAt) — raised and cleared events of one alarm share it */
export function alarmInstanceIdFor(globalAssetId: string, ruleId: string, raisedAt: string): string {
  return hashId('alm_', `${globalAssetId}|${ruleId}|${raisedAt}`);
}

/** `rdg_` + 26 base32 of sha256(assetId|meterId|observedAt of the reading sample) — CMMS dedupes meter readings on it */
export function readingIdFor(assetId: string, meterId: string, observedAt: string): string {
  return hashId('rdg_', `${assetId}|${meterId}|${observedAt}`);
}

/** Groups the model events of one request (`vxchangeset`). 64 random bits — 8 hex chars would collide within a busy year */
export function newChangeSetId(): string {
  return `chg_${randomBytes(8).toString('hex')}`;
}

/**
 * Masks the password of `scheme://user:password@host…` as `***` (`mqtt://user:***@host`). The user name stays —
 * people need it to tell two connections apart. Text that is not a URL with userinfo is returned unchanged.
 * Important: string surgery, not `new URL(...).toString()` — URL serialisation rewrites other parts (case, default
 *    ports, `opc.tcp` paths) and the masked address must otherwise read exactly as configured.
 */
export function maskCredentials(url: string): string {
  // The authority ends at the first / ? #; inside it the userinfo ends at the LAST @ (a password may contain @)
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i, (whole, scheme: string, authority: string) => {
    const at = authority.lastIndexOf('@');
    if (at < 0) return whole;
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    return colon < 0 ? whole : `${scheme}${userinfo.slice(0, colon)}:***${authority.slice(at)}`;
  });
}

/** A missing seq whose follower is older than this belongs to a rolled-back transaction, not a slow one (§2.4) */
export const SETTLE_MS = 30_000;

/**
 * The part of a seq-ordered batch that is safe to hand out (outbox pitfall, §2.4).
 *
 * On PostgreSQL a sequence number is taken when a transaction inserts, but becomes visible only at commit. A reader
 * can therefore see seq 12 while seq 11 is still in flight; advancing a cursor past 11 would lose it for good.
 * So: hand out the longest prefix that is contiguous from `after`. A gap is passed only when the row after it was
 * recorded more than `settleMs` ago — by then the missing seq belongs to a rolled-back transaction, not a slow one.
 * Gaps are not only a PostgreSQL thing: the folder store leaves one where a torn write was voided after a crash, and a
 * PostgreSQL `ON CONFLICT` skip burns a seq. Such a gap is permanent, so it passes here after `settleMs` (≤ 30 s hold).
 * The routes and the dispatcher apply this only where in-flight commits exist (PostgreSQL); see routes-events.ts.
 */
export function settledPrefix<T extends { seq: number; recordedAt: string }>(
  rows: readonly T[],
  after: number,
  now: number,
  settleMs = 30_000,
): T[] {
  const out: T[] = [];
  let expected = after + 1;
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.seq < expected) continue; // already handed out (or a duplicate) — never go backwards
    if (row.seq > expected) {
      const age = now - Date.parse(row.recordedAt);
      if (!(age > settleMs)) break;
    }
    out.push(row);
    expected = row.seq + 1;
  }
  return out;
}
