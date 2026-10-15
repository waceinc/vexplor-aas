/**
 * IP address parsing and classification for the egress policy (docs/design/integration-v1.md §5.4).
 *
 * Why hand-written: `node:net` only says whether text is an IP, not which range it belongs to, and the dangerous
 * cases are exactly the disguised ones — an IPv4 loopback wrapped in IPv6 (`::ffff:127.0.0.1`, NAT64, 6to4).
 * Every address is reduced to 16 bytes; IPv4 is kept as the IPv4-mapped form so one range table covers both.
 */
import { isIPv4, isIPv6 } from 'node:net';

/** 16 bytes, IPv4 stored as ::ffff:a.b.c.d */
export type IpBytes = Uint8Array;

export function parseIp(text: string): IpBytes | undefined {
  const value = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (isIPv4(value)) return mapped(v4Bytes(value));
  if (!isIPv6(value)) return undefined;
  return v6Bytes(value.split('%')[0]!);
}

function v4Bytes(text: string): number[] {
  return text.split('.').map((part) => Number(part));
}

function mapped(v4: number[]): IpBytes {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  out.set(v4, 12);
  return out;
}

function v6Bytes(input: string): IpBytes | undefined {
  let text = input;
  // A trailing dotted quad (::ffff:127.0.0.1) is the last two groups written as IPv4 — rewrite it as hex groups
  const lastColon = text.lastIndexOf(':');
  const quad = text.slice(lastColon + 1);
  if (quad.includes('.')) {
    if (!isIPv4(quad)) return undefined;
    const [a, b, c, d] = v4Bytes(quad) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return undefined;
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = group >> 8;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

export interface Cidr {
  bytes: IpBytes;
  /** Prefix length over the 128-bit form (IPv4 /n is stored as /96+n) */
  bits: number;
}

/** `10.0.0.0/8`, `10.20.1.5`, `fd00::/8`, `::1` → CIDR over the 128-bit form; undefined when not an address */
export function parseCidr(text: string): Cidr | undefined {
  const [address, length] = text.split('/') as [string, string | undefined];
  const bytes = parseIp(address);
  if (!bytes) return undefined;
  const v4 = isIPv4(address);
  const max = v4 ? 32 : 128;
  const bits = length === undefined ? max : Number(length);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (length !== undefined && !/^\d+$/.test(length))) return undefined;
  return { bytes, bits: v4 ? 96 + bits : bits };
}

export function cidrContains(cidr: Cidr, address: IpBytes): boolean {
  for (let bit = 0; bit < cidr.bits; bit++) {
    const mask = 0x80 >> (bit % 8);
    if ((cidr.bytes[bit >> 3]! & mask) !== (address[bit >> 3]! & mask)) return false;
  }
  return true;
}

const cidrs = (list: string[]): Cidr[] => list.map((text) => parseCidr(text)!);

/** Never reachable as a target, whatever the allowlist says */
const ALWAYS_BLOCKED = cidrs([
  '127.0.0.0/8',
  '0.0.0.0/8',
  '169.254.0.0/16',
  // Azure platform endpoint (WireServer) — a public-looking address every Azure VM and App Service reaches; it serves
  // platform agent and DHCP data, so a webhook URL must never point a server hosted on Azure at it
  '168.63.129.16/32',
  '224.0.0.0/4',
  // 240/4 is reserved and contains the limited broadcast 255.255.255.255
  '240.0.0.0/4',
  '::1/128',
  '::/128',
  'fe80::/10',
  'ff00::/8',
]);

/** Reachable only when the allowlist names them */
const PRIVATE = cidrs(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fec0::/10']);

/**
 * Special-purpose ranges (IANA registry) that are not ordinary internet hosts: IETF protocol assignments, benchmarking,
 * documentation, discard, Teredo / IETF IPv6 assignments, the local-use NAT64 prefix and SIIT-translated addresses.
 * Reachable only when the allowlist names them, like private ranges.
 */
const SPECIAL = cidrs([
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '2001:db8::/32',
  '100::/64',
  '2001::/23',
  '64:ff9b:1::/48',
  '::ffff:0:0:0/96',
]);

/**
 * IPv6 forms that carry an IPv4 address inside — they are judged by the IPv4 they carry (every candidate decoding).
 * Important: without this `64:ff9b::7f00:1` (NAT64) or `2002:7f00:1::` (6to4) would reach 127.0.0.1 on hosts with those
 *    translators while looking like ordinary public IPv6.
 */
export function embeddedV4(address: IpBytes): IpBytes[] {
  const isZero = (from: number, to: number): boolean => address.slice(from, to).every((byte) => byte === 0);
  const last32 = (): IpBytes => mapped([...address.slice(12, 16)]);
  const out: IpBytes[] = [];
  // IPv4-compatible ::a.b.c.d (deprecated) — but :: and ::1 are themselves
  if (isZero(0, 12) && !(isZero(12, 15) && address[15]! <= 1)) out.push(last32());
  // SIIT IPv4-translated ::ffff:0:a.b.c.d
  if (isZero(0, 8) && address[8] === 0xff && address[9] === 0xff && isZero(10, 12)) out.push(last32());
  // NAT64 well-known prefix 64:ff9b::/96
  if (address[0] === 0x00 && address[1] === 0x64 && address[2] === 0xff && address[3] === 0x9b && isZero(4, 12)) out.push(last32());
  // Local-use NAT64 64:ff9b:1::/48 — the IPv4 sits after the /48 (RFC 6052: bytes 6-7 and 9-10) or in the last 32 bits
  if (address[0] === 0x00 && address[1] === 0x64 && address[2] === 0xff && address[3] === 0x9b && address[4] === 0x00 && address[5] === 0x01) {
    out.push(mapped([address[6]!, address[7]!, address[9]!, address[10]!]), last32());
  }
  // 6to4 2002:AABB:CCDD::/48
  if (address[0] === 0x20 && address[1] === 0x02) out.push(mapped([...address.slice(2, 6)]));
  return out;
}

export type AddressClass = 'blocked' | 'private' | 'public';

export function classifyAddress(address: IpBytes): AddressClass {
  const inner = embeddedV4(address).map(classifyAddress);
  if (inner.includes('blocked')) return 'blocked';
  if (ALWAYS_BLOCKED.some((range) => cidrContains(range, address))) return 'blocked';
  if (inner.includes('private')) return 'private';
  if (PRIVATE.some((range) => cidrContains(range, address))) return 'private';
  if (SPECIAL.some((range) => cidrContains(range, address))) return 'private';
  return 'public';
}

/** Text form for logs and status — IPv4-mapped addresses are shown as plain IPv4 */
export function formatIp(address: IpBytes): string {
  const isMapped = address.slice(0, 10).every((byte) => byte === 0) && address[10] === 0xff && address[11] === 0xff;
  if (isMapped) return [...address.slice(12, 16)].join('.');
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push((address[index]! << 8) | address[index + 1]!);
  // RFC 5952: compress the longest run (≥ 2) of zero groups
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > bestLength) [bestStart, bestLength] = [start, length];
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}
