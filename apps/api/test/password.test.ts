/**
 * Password hashing and rules.
 *
 * Important: what is guarded here is not "it hashes" but **whether old hashes can still be verified** and
 *    **whether the plaintext never leaks**. Both are easy to break later when the cost is raised.
 */
import { describe, expect, it } from 'vitest';
import { ServiceBusyError } from '../src/http.js';
import { checkPasswordRule, hashPassword, PasswordHashGate, verifyPassword } from '../src/password.js';

describe('password hashing', () => {
  it('the right password passes, a wrong one is blocked', async () => {
    const stored = await hashPassword('열-글자-넘는-비밀번호');
    expect(await verifyPassword('열-글자-넘는-비밀번호', stored)).toBe(true);
    expect(await verifyPassword('열-글자-넘는-비밀번호 ', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('Important: the stored form does not contain the plaintext', async () => {
    const secret = 'MySecretPassword1';
    const stored = await hashPassword(secret);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('the stored form differs each time even for the same password — a salt is added', async () => {
    const a = await hashPassword('같은비밀번호입니다');
    const b = await hashPassword('같은비밀번호입니다');
    expect(a).not.toBe(b);
    expect(await verifyPassword('같은비밀번호입니다', a)).toBe(true);
    expect(await verifyPassword('같은비밀번호입니다', b)).toBe(true);
  });

  it('Important: the cost is recorded, so hashes made with old parameters still verify', async () => {
    // Pretend an old version made it with N=16384 and build that form directly
    const { scrypt } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const run = promisify(scrypt) as (
      p: string, s: Buffer, l: number, o: { N: number; r: number; p: number; maxmem: number },
    ) => Promise<Buffer>;
    const salt = Buffer.from('소금소금소금소금');
    const old = await run('옛날비밀번호입니다', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const stored = `scrypt$16384$8$1$${salt.toString('base64')}$${old.toString('base64')}`;
    expect(await verifyPassword('옛날비밀번호입니다', stored)).toBe(true);
  });

  it('a malformed stored form returns false instead of throwing — no details leak to the login screen', async () => {
    for (const bad of ['', 'x', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$abc$8$1$c2E=$aGFzaA==']) {
      expect(await verifyPassword('아무비밀번호나요', bad)).toBe(false);
    }
  });

  it('Important: an absurd recorded cost is rejected without computing — so the server does not stall', async () => {
    const huge = `scrypt$${2 ** 25}$8$1$c2FsdA==$aGFzaA==`;
    expect(await verifyPassword('아무비밀번호나요', huge)).toBe(false);
  });
});

describe('password rules', () => {
  it('must be at least 10 characters', () => {
    expect(checkPasswordRule('짧다')).toContain('10자');
    expect(checkPasswordRule('1234567890')).toBeUndefined();
  });

  it('leading or trailing spaces are blocked — they could never be matched later', () => {
    expect(checkPasswordRule(' 앞에빈칸이있는열자넘는것')).toContain('빈칸');
    expect(checkPasswordRule('뒤에빈칸이있는열자넘는것 ')).toContain('빈칸');
  });

  it('too long is blocked', () => {
    expect(checkPasswordRule('가'.repeat(201))).toContain('깁니다');
  });

  it('Important: does not force uppercase or symbols — only length matters (NIST SP 800-63B)', () => {
    expect(checkPasswordRule('소문자만으로된긴비밀번호')).toBeUndefined();
  });
});

describe('password hashes run a few at a time (red-team L4, 2026-10-16)', () => {
  it('queues past the concurrency cap and refuses with 503 once the queue is full', async () => {
    const gate = new PasswordHashGate(1, 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push('first');
      await held;
    });
    const second = gate.run(async () => {
      order.push('second');
    });
    // One running, one waiting — the third has no room
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({ status: 503 });
    expect(order).toEqual(['first']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('the busy error tells the client when to retry', async () => {
    const gate = new PasswordHashGate(1, 0);
    let release!: () => void;
    const running = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    const refused = await gate.run(async () => undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceBusyError);
    expect((refused as ServiceBusyError).retryAfterSeconds).toBeGreaterThan(0);
    release();
    await running;
  });
});
