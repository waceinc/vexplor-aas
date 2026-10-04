/**
 * IDTA Part 2는 경로에 들어가는 식별자를 **base64url로 인코딩**하도록 정한다.
 * (id가 IRI·IRDI라 슬래시·#이 그대로 들어가면 경로가 깨진다)
 *
 * 패딩(=)은 규격상 없어도 되고 붙어 있어도 되므로 읽을 때는 둘 다 받는다.
 * Buffer를 쓰지 않는 이유는 이 함수가 나중에 브라우저 쪽 클라이언트에서도 쓰이기 때문이다.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeIdentifier(value: string): string {
  const data = encoder.encode(value);
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += ALPHABET[c & 63]!;
  }
  return out;
}

export function decodeIdentifier(value: string): string {
  const clean = value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error(`base64url이 아닙니다: ${value}`);
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return decoder.decode(new Uint8Array(out));
}
