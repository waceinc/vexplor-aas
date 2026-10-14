/**
 * Egress policy — where webhooks and MQTT sinks may connect (docs/design/integration-v1.md §5.4, D17).
 *
 * Why: a subscription makes this server open connections to an address someone typed in. Without a policy that is
 * an SSRF relay — the cloud metadata service (169.254.169.254), the database next door, the server's own admin port.
 *
 * Rules, in order:
 *  1. Schemes: webhook `https:` / `http:`, mqtt `mqtts:` / `mqtt:`. No userinfo on http(s) (credentials in URLs leak).
 *  2. The host is resolved **once**; every answer must pass, and the first one is pinned for the connection — a DNS
 *     server that answers "public" for the check and "127.0.0.1" for the connect (rebinding) gets nowhere.
 *  3. Loopback, link-local, unspecified, multicast and broadcast are always refused, also when disguised as IPv6.
 *  4. Private ranges only when `AAS_INTEGRATION_ALLOW` names them (CIDR, IP or hostname, each optionally `:port`).
 *  5. Plain `http:` / `mqtt:` only to allowlisted targets.
 *  6. Well-known service ports (SSH, SMB, databases, PLC protocols …) only when an allow entry names that port.
 *  7. Demo mode refuses everything.
 * Checked at create / patch time and again before every attempt (DNS answers change).
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

import { fill, tr } from '@aas/core';
import type { SubscriptionKind } from '@aas/store';

import { classifyAddress, cidrContains, formatIp, parseCidr, parseIp, type Cidr, type IpBytes } from './egress-ip.js';

export interface AllowEntry {
  /** As written in the setting — shown on the status page */
  text: string;
  host?: string;
  cidr?: Cidr;
  port?: number;
}

export interface EgressPolicy {
  allow: readonly AllowEntry[];
  demo: boolean;
  /** All A/AAAA answers for a host name */
  resolve: (host: string) => Promise<string[]>;
}

export type EgressCheck =
  | { ok: true; host: string; port: number; address: string; tls: boolean }
  | { ok: false; reason: string };

/** Ports of services that must never receive a webhook by accident (SSH, SMTP, S7, SMB, Modbus, databases, EtherNet/IP …) */
export const BLOCKED_PORTS: readonly number[] = [22, 23, 25, 102, 135, 139, 445, 502, 1433, 1521, 3306, 3389, 5432, 6379, 11211, 27017, 44818];

const SCHEMES: Record<SubscriptionKind, Record<string, { tls: boolean; port: number }>> = {
  webhook: { 'https:': { tls: true, port: 443 }, 'http:': { tls: false, port: 80 } },
  mqtt: { 'mqtts:': { tls: true, port: 8883 }, 'mqtt:': { tls: false, port: 1883 } },
};

/** A DNS answer that does not come in 5 s is a failure (retried by the schedule), never a hung delivery lane */
export const RESOLVE_TIMEOUT_MS = 5_000;

export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Every address the operating system would connect to — the same resolver the connection would use (hosts file included) */
export function dnsResolveAll(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => entry.address));
    });
  });
}

/** One `AAS_INTEGRATION_ALLOW` entry: `10.20.0.0/16`, `10.20.1.5:8080`, `mes.plant.local`, `[fd00::/8]:443`, `fd00::5` */
export function parseAllowEntry(raw: string): AllowEntry | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  let target = text;
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) {
    target = bracket[1]!;
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const at = text.lastIndexOf(':');
    target = text.slice(0, at);
    port = Number(text.slice(at + 1));
  }
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return undefined;
  const cidr = parseCidr(target);
  if (cidr) return { text, cidr, ...(port === undefined ? {} : { port }) };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(target)) return undefined;
  return { text, host: target.toLowerCase(), ...(port === undefined ? {} : { port }) };
}

/** Reads `AAS_INTEGRATION_ALLOW`. An entry that cannot be read is an error — a silently ignored allow entry is a support case */
export function egressPolicyFromEnv(
  env: Record<string, string | undefined>,
  demo: boolean,
  resolve: (host: string) => Promise<string[]> = dnsResolveAll,
): EgressPolicy {
  const allow: AllowEntry[] = [];
  for (const raw of (env['AAS_INTEGRATION_ALLOW'] ?? '').split(',')) {
    if (raw.trim() === '') continue;
    const entry = parseAllowEntry(raw);
    if (!entry) throw new Error(fill(tr('AAS_INTEGRATION_ALLOW 항목을 읽지 못했습니다: {0}'), { 0: raw.trim() }));
    allow.push(entry);
  }
  return { allow, demo, resolve };
}

function entryCovers(entry: AllowEntry, host: string, address: IpBytes): boolean {
  if (entry.host !== undefined) return entry.host === host;
  return entry.cidr !== undefined && cidrContains(entry.cidr, address);
}

/**
 * Host and port of a target URL with WHATWG IPv4 normalisation also for `mqtt:` — `new URL('mqtt://2130706433')` keeps
 * the host opaque, but the resolver would still read it as 127.0.0.1. Reparsing the authority as http normalises it.
 */
function targetOf(url: string, kind: SubscriptionKind): { parsed: URL; host: string; port: number; tls: boolean } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: fill(tr('주소를 읽지 못했습니다: {0}'), { 0: url }) };
  }
  const scheme = SCHEMES[kind][parsed.protocol];
  if (!scheme) {
    return { reason: fill(tr('{0} 구독에는 {1} 주소만 쓸 수 있습니다.'), { 0: kind, 1: Object.keys(SCHEMES[kind]).join(' / ') }) };
  }
  if ((parsed.username !== '' || parsed.password !== '') && kind === 'webhook') {
    return { reason: tr('웹훅 주소에는 사용자 이름이나 비밀번호를 넣을 수 없습니다.') };
  }
  let normalised: URL;
  try {
    normalised = new URL(`http://${parsed.host}`);
  } catch {
    return { reason: fill(tr('주소를 읽지 못했습니다: {0}'), { 0: url }) };
  }
  const host = normalised.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return { reason: fill(tr('주소를 읽지 못했습니다: {0}'), { 0: url }) };
  const port = parsed.port === '' ? scheme.port : Number(parsed.port);
  return { parsed, host, port, tls: scheme.tls };
}

/** Decides whether `url` may be connected to now, and which address to pin */
export async function checkTarget(url: string, kind: SubscriptionKind, policy: EgressPolicy): Promise<EgressCheck> {
  if (policy.demo) return { ok: false, reason: tr('체험판에서는 외부로 연결하지 않습니다.') };
  const target = targetOf(url, kind);
  if ('reason' in target) return { ok: false, reason: target.reason };
  const { host, port, tls } = target;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: fill(tr('{0}은(는) 이 서버 자신입니다 — 연결하지 않습니다.'), { 0: host }) };
  }
  // A trailing dot is the same name (`localhost.`) — judge the name without it
  if (host.endsWith('.') && (host === 'localhost.' || host.endsWith('.localhost.'))) {
    return { ok: false, reason: fill(tr('{0}은(는) 이 서버 자신입니다 — 연결하지 않습니다.'), { 0: host }) };
  }

  let answers: string[];
  const literal = parseIp(host);
  if (literal) answers = [host];
  else {
    try {
      answers = await withTimeout(policy.resolve(host), RESOLVE_TIMEOUT_MS, `DNS lookup timed out after ${RESOLVE_TIMEOUT_MS} ms`);
    } catch (error) {
      return { ok: false, reason: fill(tr('{0}의 주소를 찾지 못했습니다: {1}'), { 0: host, 1: error instanceof Error ? error.message : String(error) }) };
    }
  }
  if (answers.length === 0) return { ok: false, reason: fill(tr('{0}의 주소를 찾지 못했습니다: {1}'), { 0: host, 1: 'no address' }) };

  let pinned: string | undefined;
  for (const answer of answers) {
    const address = parseIp(answer);
    if (!address) return { ok: false, reason: fill(tr('{0}의 주소를 찾지 못했습니다: {1}'), { 0: host, 1: answer }) };
    const shown = formatIp(address);
    const kindOf = classifyAddress(address);
    if (kindOf === 'blocked') {
      return { ok: false, reason: fill(tr('{0}({1})은(는) 루프백·링크 로컬·멀티캐스트 주소라 연결하지 않습니다.'), { 0: host, 1: shown }) };
    }
    const covering = policy.allow.filter((entry) => entryCovers(entry, host, address));
    const allowedHere = covering.some((entry) => entry.port === undefined || entry.port === port);
    if (kindOf === 'private' && !allowedHere) {
      return {
        ok: false,
        reason: fill(tr('{0}({1})은(는) 사내 주소입니다 — AAS_INTEGRATION_ALLOW에 적어야 연결합니다.'), { 0: host, 1: shown }),
      };
    }
    if (!tls && !allowedHere) {
      return {
        ok: false,
        reason: fill(tr('암호화하지 않은 연결({0})은 AAS_INTEGRATION_ALLOW에 적은 대상에만 씁니다.'), { 0: target.parsed.protocol }),
      };
    }
    if (BLOCKED_PORTS.includes(port) && !covering.some((entry) => entry.port === port)) {
      return {
        ok: false,
        reason: fill(tr('포트 {0}은(는) 다른 서비스가 쓰는 포트라 막혀 있습니다 — AAS_INTEGRATION_ALLOW에 그 포트까지 적어야 합니다.'), { 0: port }),
      };
    }
    pinned ??= shown;
  }
  return { ok: true, host, port, address: pinned!, tls };
}

/**
 * A `lookup` for `http.request` / `net.connect` that always answers the pinned address — the connection goes exactly
 * where the check looked, while TLS still verifies the certificate against the host name.
 */
export function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const done = typeof options === 'function' ? (options as (...args: unknown[]) => void) : callback;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) done(null, [{ address, family }]);
    else done(null, address, family);
  }) as LookupFunction;
}
