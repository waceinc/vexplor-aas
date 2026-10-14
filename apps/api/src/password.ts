/**
 * Password hashing — Node built-in `scrypt`.
 *
 * Important: **no added dependencies.** bcrypt/argon2 need native builds, which breaks the installer bundle (which ships
 *    only node.exe) and bringing it into air-gapped networks. scrypt is built into Node, is an RFC 7914 standard, and
 *    is designed to be memory-hard (expensive even when hammered with GPUs), which makes it fit for password storage.
 *
 * Important: **the plaintext is never kept anywhere** — not in logs, error messages or history.
 *
 * Stored form: `scrypt$N$r$p$<salt base64>$<hash base64>`
 * Why the parameters are stored with it — even after raising the cost later, **old hashes still verify**.
 * After raising it, rehash with the new cost on the spot when a login succeeds.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { tr } from '@aas/core';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters.
 * N=2^15 (32768) · r=8 · p=1 — uses about 32MB per hash. Under 0.1s on a typical PC,
 * and expensive enough to stop attackers trying millions of times per second.
 * Important: maxmem must be generous — otherwise it hits Node's default cap (32MB) exactly and blows up.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Check whether it matches.
 * Important: compare in **constant time** (timingSafeEqual). If a mismatch at an early position returns faster,
 *    the hash can be learned one character at a time from response times — the same reason as the token comparison in auth.ts.
 * Important: a malformed hash is **silently false**. Throwing would reveal "that account has a broken hash"
 *    on the login screen.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // If an absurd value is stored, the server stalls computing it — reject it
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Password rules — returns a human-readable reason on violation, undefined if valid.
 *
 * Important: do not force complexity (mixing uppercase/symbols). People just conform with obvious shapes like `Passw0rd!`,
 *    which is known to actually make passwords weaker (NIST SP 800-63B). **Length** is better.
 */
export function checkPasswordRule(password: string): string | undefined {
  if (password.length < 10) return tr('비밀번호는 10자 이상이어야 합니다.');
  if (password.length > 200) return tr('비밀번호가 너무 깁니다(200자 이하).');
  if (/^\s|\s$/.test(password)) return tr('비밀번호 앞뒤의 빈칸은 빼 주십시오 — 나중에 못 맞춥니다.');
  return undefined;
}
