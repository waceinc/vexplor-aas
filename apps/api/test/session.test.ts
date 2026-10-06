/**
 * 세션·로그인 시도 제한.
 *
 * 시각을 주입해 **시간이 흐른 상황**을 그대로 만든다 — 실제로 8시간 기다릴 수는 없다.
 */
import { describe, expect, it } from 'vitest';
import { LoginThrottle, SessionStore } from '../src/session.js';

const HOUR = 60 * 60 * 1000;

describe('세션', () => {
  it('만들고 찾는다', () => {
    const store = new SessionStore();
    const key = store.create('user_1');
    expect(store.get(key)?.userId).toBe('user_1');
    expect(store.get('없는열쇠')).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
  });

  it('🔴 열쇠는 추측할 수 없어야 한다 — 길고 매번 다르다', () => {
    const store = new SessionStore();
    const keys = new Set(Array.from({ length: 50 }, () => store.create('user_1')));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key.length).toBeGreaterThanOrEqual(43); // 32바이트 base64url
  });

  it('로그아웃하면 끊긴다', () => {
    const store = new SessionStore();
    const key = store.create('user_1');
    store.drop(key);
    expect(store.get(key)).toBeUndefined();
  });

  it('그 사람의 세션을 한꺼번에 끊는다 — 잠그거나 비밀번호를 바꿨을 때', () => {
    const store = new SessionStore();
    const a = store.create('user_1');
    const b = store.create('user_1');
    const other = store.create('user_2');
    store.dropUser('user_1');
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeUndefined();
    expect(store.get(other)?.userId).toBe('user_2');
  });

  it('🔴 8시간 아무 것도 안 하면 끊긴다', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    now += 7 * HOUR;
    expect(store.get(key)?.userId).toBe('user_1'); // 아직 산다
    now += 9 * HOUR; // 마지막으로 쓴 지 9시간
    expect(store.get(key)).toBeUndefined();
  });

  it('쓰는 동안은 안 끊긴다 — 쓸 때마다 시계가 다시 간다', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    for (let i = 0; i < 10; i += 1) {
      now += 7 * HOUR;
      expect(store.get(key)?.userId).toBe('user_1');
    }
  });

  it('🔴 아무리 써도 7일이 지나면 다시 로그인한다', () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const key = store.create('user_1');
    for (let i = 0; i < 30; i += 1) {
      now += 6 * HOUR;
      store.get(key);
    }
    expect(store.get(key)).toBeUndefined(); // 7일(=168시간)을 넘겼다
  });

  it('만료된 것은 새 세션을 만들 때 치워진다 — 따로 타이머를 두지 않는다', () => {
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

describe('로그인 시도 제한', () => {
  it('다섯 번 틀리면 막는다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 4; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(false);
    throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
  });

  it('성공하면 센 것이 지워진다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    throttle.pass('kim');
    expect(throttle.blocked('kim')).toBe(false);
  });

  it('시간이 지나면 풀린다', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
    now += 6 * 60 * 1000;
    expect(throttle.blocked('kim')).toBe(false);
  });

  it('🔴 IP가 아니라 로그인 이름으로 센다 — 공장은 NAT 하나로 묶여 있다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim');
    expect(throttle.blocked('kim')).toBe(true);
    expect(throttle.blocked('lee')).toBe(false); // 옆 사람은 멀쩡하다
  });

  it('대소문자를 가리지 않는다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('Kim');
    expect(throttle.blocked('kim')).toBe(true);
  });
});

describe('로그인 시도 제한 — 남이 내 계정을 잠그지 못한다 (2026-10-06 보안 점검)', () => {
  it('다른 주소에서 틀린 것은 내 주소를 막지 않는다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 5; i += 1) throttle.fail('kim', '203.0.113.9');
    expect(throttle.blocked('kim', '203.0.113.9')).toBe(true);
    expect(throttle.blocked('kim', '198.51.100.7')).toBe(false);
  });

  it('주소를 바꿔 가며 대입해도 계정 전체 상한에서 멈춘다', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 50; i += 1) throttle.fail('kim', `10.0.0.${i}`);
    expect(throttle.blocked('kim', '10.9.9.9')).toBe(true);
  });
});
