/**
 * Sessions and login attempt limiting.
 *
 * Time is injected to recreate **the passage of time** directly — we cannot actually wait 8 hours.
 */
import { describe, expect, it } from 'vitest';
import { LoginThrottle, SessionStore } from '../src/session.js';

const HOUR = 60 * 60 * 1000;

describe('sessions', () => {
  it('creates and finds', () => {
    const store = new SessionStore();
    const key = store.create('user_1');
    expect(store.get(key)?.userId).toBe('user_1');
    expect(store.get('없는열쇠')).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
  });

  it('Important: keys must be unguessable — long and different every time', () => {
    const store = new SessionStore();
    const keys = new Set(Array.from({ length: 50 }, () => store.create('user_1')));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it('logout ends it', () => {
    const store = new SessionStore();
    const key = store.create('user_1');
    store.drop(key);
    expect(store.get(key)).toBeUndefined();
  });

  it('ends all of a person sessions at once — when locked or after a password change', () => {
    const store = new SessionStore();
    const a = store.create('user_1');
    const b = store.create('user_1');
    const other = store.create('user_2');
    store.dropUser('user_1');
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeUndefined();
    expect(store.get(other)?.userId).toBe('user_2');
  });

  it('Important: ends after 8 hours of inactivity', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    now += 7 * HOUR;
    expect(store.get(key)?.userId).toBe('user_1'); // still alive
    now += 9 * HOUR; // 9 hours since last use
    expect(store.get(key)).toBeUndefined();
  });

  it('does not end while in use — the clock restarts on every use', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    for (let i = 0; i < 10; i += 1) {
      now += 7 * HOUR;
      expect(store.get(key)?.userId).toBe('user_1');
    }
  });

  it('Important: no matter how much it is used, login is required again after 7 days', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    for (let i = 0; i < 30; i += 1) {
      now += 6 * HOUR;
      store.get(key);
    }
    expect(store.get(key)).toBeUndefined(); // past 7 days (=168 hours)
  });

  it('expired ones are cleaned up when a new session is created — no separate timer', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    store.create('user_1');
    store.create('user_2');
    expect(store.size).toBe(2);
    now += 9 * HOUR;
    store.create('user_3');
    expect(store.size).toBe(1);
  });
});

describe('login attempt limiting', () => {
  it('blocks after five failures', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 4; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(false);
    throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
  });

  it('success clears the count', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    throttle.pass('kim');
    expect(throttle.blocked('kim')).toBe(false);
  });

  it('unblocks after time passes', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
    now += 6 * 60 * 1000;
    expect(throttle.blocked('kim')).toBe(false);
  });

  it('Important: counts by login name, not IP — a factory sits behind a single NAT', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
    expect(throttle.blocked('lee')).toBe(false); // the person next to them is fine
  });

  it('is case-insensitive', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('Kim');
    expect(throttle.blocked('kim')).toBe(true);
  });
});

describe('login attempt limiting — others cannot lock my account (2026-10-06 security review)', () => {
  it('failures from another address do not block my address', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim', '203.0.113.9');
    expect(throttle.blocked('kim', '203.0.113.9')).toBe(true);
    expect(throttle.blocked('kim', '198.51.100.7')).toBe(false);
  });

  it('rotating addresses slows the account down at the account-wide limit — without locking a fresh address out', () => {
    // Important: this was a hard block until the 2026-10-16 red-team review (L1) — a targeted lockout of the real owner
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 49; i += 1) throttle.fail('kim', `10.0.0.${i}`);
    expect(throttle.slowdownMs('kim')).toBe(0);
    throttle.fail('kim', '10.0.0.49');
    expect(throttle.slowdownMs('kim')).toBeGreaterThan(0);
    expect(throttle.blocked('kim', '10.9.9.9')).toBe(false);
  });
});
