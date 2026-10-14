/**
 * Integration ids and shared helpers (apps/api/src/integration/ids.ts) — deterministic event ids (D6), credential
 * masking, and the outbox settle rule (§2.4, platform 7.2 "out-of-order commit").
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  alarmInstanceIdFor,
  base32Encode,
  canonicalJson,
  eventIdFor,
  maskCredentials,
  newChangeSetId,
  readingIdFor,
  settledPrefix,
} from '../src/integration/ids.js';

/** Independent base32 (bit string) to cross-check the streaming encoder */
function base32Reference(bytes: Uint8Array): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

describe('base32', () => {
  it('matches an independent bit-string encoder for every length 0..40', () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = createHash('sha256').update(String(length)).digest().subarray(0, length);
      const all = new Uint8Array(length);
      all.set(bytes);
      if (length > 32) all.fill(0xa5, 32);
      expect(base32Encode(all)).toBe(base32Reference(all));
    }
  });

  it('known values and the Crockford alphabet (no I, L, O, U)', () => {
    expect(base32Encode(new Uint8Array([]))).toBe('');
    expect(base32Encode(new Uint8Array([0xff]))).toBe('ZW');
    expect(base32Encode(new Uint8Array([0, 0, 0, 0, 0]))).toBe('00000000');
    expect(base32Encode(new Uint8Array(32).fill(0xff))).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });
});

describe('deterministic ids', () => {
  const type = 'kr.vexplor.aas.equipment.state.changed.v1';

  it('same inputs → same id (a re-processed cycle is not re-emitted); any input change → another id', () => {
    const id = eventIdFor(type, 'urn:a', 'state', '2026-10-14T01:41:06.900Z', { state: 'alarm' });
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(eventIdFor(type, 'urn:a', 'state', '2026-10-14T01:41:06.900Z', { state: 'alarm' })).toBe(id);
    const others = [
      eventIdFor('kr.vexplor.aas.equipment.alarm.raised.v1', 'urn:a', 'state', '2026-10-14T01:41:06.900Z', { state: 'alarm' }),
      eventIdFor(type, 'urn:b', 'state', '2026-10-14T01:41:06.900Z', { state: 'alarm' }),
      eventIdFor(type, 'urn:a', 'other', '2026-10-14T01:41:06.900Z', { state: 'alarm' }),
      eventIdFor(type, 'urn:a', 'state', '2026-10-14T01:41:07.900Z', { state: 'alarm' }),
      eventIdFor(type, 'urn:a', 'state', '2026-10-14T01:41:06.900Z', { state: 'run' }),
    ];
    expect(new Set([id, ...others]).size).toBe(6);
  });

  it('key order inside the value does not change the id', () => {
    expect(eventIdFor(type, 's', 'k', 't', { a: 1, b: { c: 2, d: 3 } })).toBe(eventIdFor(type, 's', 'k', 't', { b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalJson({ b: 1, a: [1, { y: 2, x: 1 }], u: undefined })).toBe('{"a":[1,{"x":1,"y":2}],"b":1}');
  });

  it('field boundaries are unambiguous ("ab"+"c" ≠ "a"+"bc")', () => {
    expect(eventIdFor(type, 'ab', 'c', 't', null)).not.toBe(eventIdFor(type, 'a', 'bc', 't', null));
  });

  it('alarm instance and reading ids hash the documented "|"-joined input', () => {
    const expected = 'alm_' + base32Reference(createHash('sha256').update('urn:a|alarm-main|2026-10-14T01:00:00.000Z').digest()).slice(0, 26);
    expect(alarmInstanceIdFor('urn:a', 'alarm-main', '2026-10-14T01:00:00.000Z')).toBe(expected);
    expect(readingIdFor('urn:a', 'produced', '2026-10-14T01:00:00.000Z')).toMatch(/^rdg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(readingIdFor('urn:a', 'produced', '2026-10-14T01:00:00.000Z')).not.toBe(readingIdFor('urn:a', 'produced', '2026-10-14T01:00:01.000Z'));
  });

  it('change set ids are chg_ + 16 hex and do not repeat', () => {
    const ids = Array.from({ length: 200 }, () => newChangeSetId());
    for (const id of ids) expect(id).toMatch(/^chg_[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('maskCredentials', () => {
  it('masks the password, keeps the user name and the rest exactly as written', () => {
    expect(maskCredentials('mqtt://user:secret@broker.local:1883/x')).toBe('mqtt://user:***@broker.local:1883/x');
    expect(maskCredentials('opc.tcp://Admin:p@ss:w0rd@10.0.0.5:4840/UA/Server')).toBe('opc.tcp://Admin:***@10.0.0.5:4840/UA/Server');
    expect(maskCredentials('HTTPS://a:b@Host/Path?q=1')).toBe('HTTPS://a:***@Host/Path?q=1');
    expect(maskCredentials('mqtt://:onlypass@h')).toBe('mqtt://:***@h');
  });

  it('leaves addresses without a password untouched', () => {
    expect(maskCredentials('opc.tcp://192.168.0.50:4840')).toBe('opc.tcp://192.168.0.50:4840');
    expect(maskCredentials('mqtt://user@h:1883')).toBe('mqtt://user@h:1883');
    expect(maskCredentials('modbus-tcp://10.0.0.1:502?unit=1&tag=a@b')).toBe('modbus-tcp://10.0.0.1:502?unit=1&tag=a@b');
    expect(maskCredentials('not a url')).toBe('not a url');
  });
});

describe('settledPrefix', () => {
  const now = Date.parse('2026-10-14T00:10:00.000Z');
  const row = (seq: number, ageMs: number) => ({ seq, recordedAt: new Date(now - ageMs).toISOString() });

  it('a contiguous batch passes whole', () => {
    expect(settledPrefix([row(11, 0), row(12, 0), row(13, 0)], 10, now).map((r) => r.seq)).toEqual([11, 12, 13]);
  });

  it('a young gap holds everything behind it (the missing seq may still commit)', () => {
    expect(settledPrefix([row(11, 0), row(13, 1000), row(14, 0)], 10, now).map((r) => r.seq)).toEqual([11]);
    // a gap right after the cursor
    expect(settledPrefix([row(12, 1000)], 10, now)).toEqual([]);
  });

  it('an old gap passes — the missing seq was rolled back', () => {
    expect(settledPrefix([row(11, 0), row(13, 31_000), row(14, 0)], 10, now).map((r) => r.seq)).toEqual([11, 13, 14]);
    // exactly at the horizon still holds
    expect(settledPrefix([row(12, 30_000)], 10, now)).toEqual([]);
    expect(settledPrefix([row(12, 5_000)], 10, now, 1_000).map((r) => r.seq)).toEqual([12]);
  });

  it('a second, young gap later in the batch stops there', () => {
    expect(settledPrefix([row(11, 60_000), row(13, 60_000), row(15, 0)], 10, now).map((r) => r.seq)).toEqual([11, 13]);
  });

  it('unsorted input and rows at or before the cursor are handled', () => {
    expect(settledPrefix([row(12, 0), row(10, 0), row(11, 0)], 10, now).map((r) => r.seq)).toEqual([11, 12]);
    expect(settledPrefix([], 10, now)).toEqual([]);
  });
});
