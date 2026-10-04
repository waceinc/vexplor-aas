/**
 * 비밀번호 해시 — Node 내장 `scrypt`.
 *
 * 🔴 **의존성을 늘리지 않는다.** bcrypt·argon2는 네이티브 빌드가 필요해 설치판(node.exe만 담는
 *    꾸러미)과 폐쇄망 반입을 깨뜨린다. scrypt는 Node에 들어 있고 RFC 7914 표준이며
 *    메모리를 많이 쓰도록 설계돼(GPU로 몰아쳐도 비싸다) 비밀번호 저장에 적합하다.
 *
 * 🔴 **원문은 어디에도 남기지 않는다.** 로그·오류 메시지·이력 어디에도.
 *
 * 저장 형태: `scrypt$N$r$p$<salt base64>$<hash base64>`
 * 매개변수를 함께 적는 이유 — 나중에 비용을 올려도 **옛 해시를 그대로 검증**할 수 있다.
 * 올린 뒤 로그인에 성공하면 그 자리에서 새 비용으로 다시 해시하면 된다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * 비용 매개변수.
 * N=2^15(32768) · r=8 · p=1 — 한 번에 약 32MB를 쓴다. 보통 PC에서 0.1초 안쪽이고,
 * 공격자가 초당 수백만 번 시도하는 것을 막을 만큼은 비싸다.
 * 🔴 maxmem을 넉넉히 줘야 한다 — Node 기본 상한(32MB)에 딱 걸려 터진다.
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
 * 맞는지 본다.
 * 🔴 **시간이 일정하게** 비교한다(timingSafeEqual). 앞자리부터 틀리는 지점이 빠르면
 *    응답 시간으로 해시를 한 글자씩 알아낼 수 있다 — auth.ts의 토큰 비교와 같은 이유다.
 * 🔴 모양이 깨진 해시는 **조용히 false**다. 던지면 "그 계정은 해시가 이상하다"는 사실이
 *    로그인 화면에 드러난다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // 터무니없는 값이 저장돼 있으면 계산하다 서버가 멎는다 — 거절한다
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
 * 비밀번호 규칙 — 어기면 사람 말로 된 이유를 돌려준다. 맞으면 undefined.
 *
 * 🔴 복잡도(대문자·기호 섞기)를 강요하지 않는다. 사람들이 `Passw0rd!` 같은 뻔한 꼴로 맞출 뿐
 *    실제로는 더 약해진다는 것이 알려져 있다(NIST SP 800-63B). **길이**가 낫다.
 */
export function checkPasswordRule(password: string): string | undefined {
  if (password.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  if (password.length > 200) return '비밀번호가 너무 깁니다(200자 이하).';
  if (/^\s|\s$/.test(password)) return '비밀번호 앞뒤의 빈칸은 빼 주십시오 — 나중에 못 맞춥니다.';
  return undefined;
}
