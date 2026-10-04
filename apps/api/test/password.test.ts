/**
 * 비밀번호 해시·규칙.
 *
 * 🔴 여기서 지키는 것은 "해시가 된다"가 아니라 **옛 해시를 계속 검증할 수 있는가**와
 *    **원문이 새지 않는가**다. 둘 다 나중에 비용을 올릴 때 깨지기 쉬운 자리다.
 */
import { describe, expect, it } from 'vitest';
import { checkPasswordRule, hashPassword, verifyPassword } from '../src/password.js';

describe('비밀번호 해시', () => {
  it('맞는 비밀번호는 통과, 틀린 것은 막는다', async () => {
    const stored = await hashPassword('열-글자-넘는-비밀번호');
    expect(await verifyPassword('열-글자-넘는-비밀번호', stored)).toBe(true);
    expect(await verifyPassword('열-글자-넘는-비밀번호 ', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('🔴 저장본에 원문이 들어 있지 않다', async () => {
    const secret = 'MySecretPassword1';
    const stored = await hashPassword(secret);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('같은 비밀번호라도 저장본이 매번 다르다 — 소금이 붙는다', async () => {
    const a = await hashPassword('같은비밀번호입니다');
    const b = await hashPassword('같은비밀번호입니다');
    expect(a).not.toBe(b);
    expect(await verifyPassword('같은비밀번호입니다', a)).toBe(true);
    expect(await verifyPassword('같은비밀번호입니다', b)).toBe(true);
  });

  it('🔴 비용을 적어 두므로 옛 매개변수로 만든 해시도 검증된다', async () => {
    // 옛 판이 N=16384로 만들었다고 치고, 그 꼴을 직접 만들어 본다
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

  it('모양이 깨진 저장본은 던지지 않고 false — 로그인 화면에 사정을 흘리지 않는다', async () => {
    for (const bad of ['', 'x', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$abc$8$1$c2E=$aGFzaA==']) {
      expect(await verifyPassword('아무비밀번호나요', bad)).toBe(false);
    }
  });

  it('🔴 터무니없는 비용이 적혀 있으면 계산하지 않고 거절한다 — 서버가 멎지 않게', async () => {
    const huge = `scrypt$${2 ** 25}$8$1$c2FsdA==$aGFzaA==`;
    expect(await verifyPassword('아무비밀번호나요', huge)).toBe(false);
  });
});

describe('비밀번호 규칙', () => {
  it('10자 이상이어야 한다', () => {
    expect(checkPasswordRule('짧다')).toContain('10자');
    expect(checkPasswordRule('1234567890')).toBeUndefined();
  });

  it('앞뒤 빈칸은 막는다 — 나중에 못 맞춘다', () => {
    expect(checkPasswordRule(' 앞에빈칸이있는열자넘는것')).toContain('빈칸');
    expect(checkPasswordRule('뒤에빈칸이있는열자넘는것 ')).toContain('빈칸');
  });

  it('너무 길면 막는다', () => {
    expect(checkPasswordRule('가'.repeat(201))).toContain('깁니다');
  });

  it('🔴 대문자·기호를 강요하지 않는다 — 길이만 본다(NIST SP 800-63B)', () => {
    expect(checkPasswordRule('소문자만으로된긴비밀번호')).toBeUndefined();
  });
});
