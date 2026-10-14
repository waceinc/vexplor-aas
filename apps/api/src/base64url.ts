import { fill, tr } from '@aas/core';
/**
 * IDTA Part 2 specifies that identifiers placed in paths be **base64url-encoded**.
 * (ids are IRIs/IRDIs, so raw slashes and # would break the path)
 *
 * Padding (=) is optional per the spec, so both forms are accepted when reading.
 * Buffer is not used because this function will later also be used in the browser-side client.
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
    if (index < 0) throw new Error(fill(tr('base64url이 아닙니다: {0}'), { 0: value }));
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return decoder.decode(new Uint8Array(out));
}
