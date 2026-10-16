/**
 * The remote collector's configuration file — written by whoever installs it, read once at start.
 *
 *     {
 *       "server": "https://aas.example.com",        // the one outbound destination (contract §7)
 *       "stateDir": "C:/ProgramData/VEXPLOR Edge",  // key, device id, queue, refused batches
 *       "proxy": "http://proxy.plant.local:3128",   // optional, HTTP CONNECT
 *       "caFile": "corp-ca.pem",                    // optional, a private certificate authority for the server
 *       "credentialsFile": "credentials.json",      // optional, { "<endpoint>": { "userName", "password" } }
 *       "opcua": { "pkiDir": "...", "trustFirstUse": false }
 *     }
 *
 * Important: the server address must be https — plain http only for this machine (tests). The edge refuses to start
 *    otherwise, rather than send signed batches in clear text over a factory network.
 * Important: relative paths are relative to the configuration file, not to wherever the service happens to start.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface EdgeConfig {
  server: string;
  stateDir: string;
  name: string;
  proxy?: string;
  caFile?: string;
  credentialsFile?: string;
  opcua: { pkiDir: string; trustFirstUse: boolean };
  /** How often collected samples become a batch (ms). Default 1000 */
  flushIntervalMs: number;
  /** Batches kept on disk at most; the oldest are dropped and counted beyond it. Default 100 000 */
  maxQueuedBatches: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class EdgeConfigError extends Error {}

const text = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new EdgeConfigError(`${name} must be a non-empty string`);
  return value.trim();
};

const positive = (value: unknown, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new EdgeConfigError(`${name} must be a positive integer`);
  return value;
};

/** Parses and checks the configuration; `file` resolves relative paths */
export function parseEdgeConfig(json: string, file: string): EdgeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new EdgeConfigError(`${file}: not JSON — ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new EdgeConfigError(`${file}: expected an object`);
  const input = raw as Record<string, unknown>;
  const base = dirname(file);
  const path = (value: string | undefined): string | undefined => (value === undefined ? undefined : isAbsolute(value) ? value : join(base, value));

  const server = text(input['server'], 'server');
  if (!server) throw new EdgeConfigError('server is required');
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new EdgeConfigError(`server is not an address: ${server}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new EdgeConfigError(`server must be https:// (plain http only on this machine): ${server}`);
  }
  const stateDir = path(text(input['stateDir'], 'stateDir'));
  if (!stateDir) throw new EdgeConfigError('stateDir is required');
  const proxy = text(input['proxy'], 'proxy');
  if (proxy !== undefined && !/^http:\/\/[^/]+/i.test(proxy)) throw new EdgeConfigError(`proxy must be http://host:port: ${proxy}`);
  const opcua = (input['opcua'] ?? {}) as Record<string, unknown>;
  const caFile = path(text(input['caFile'], 'caFile'));
  const credentialsFile = path(text(input['credentialsFile'], 'credentialsFile'));

  return {
    server: url.origin,
    stateDir,
    name: text(input['name'], 'name') ?? 'VEXPLOR Edge',
    ...(proxy ? { proxy } : {}),
    ...(caFile ? { caFile } : {}),
    ...(credentialsFile ? { credentialsFile } : {}),
    opcua: { pkiDir: path(text(opcua['pkiDir'], 'opcua.pkiDir')) ?? join(stateDir, 'opcua-pki'), trustFirstUse: opcua['trustFirstUse'] === true },
    flushIntervalMs: positive(input['flushIntervalMs'], 'flushIntervalMs', 1000),
    maxQueuedBatches: positive(input['maxQueuedBatches'], 'maxQueuedBatches', 100_000),
  };
}

export function loadEdgeConfig(file: string): EdgeConfig {
  return parseEdgeConfig(readFileSync(file, 'utf8'), file);
}

/** User names and passwords by endpoint — the read list names one by `credentialRef`, never carries it */
export function loadCredentials(file: string | undefined): Map<string, { userName: string; password: string }> {
  const out = new Map<string, { userName: string; password: string }>();
  if (!file) return out;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { userName?: unknown; password?: unknown }>;
  for (const [ref, entry] of Object.entries(parsed)) {
    if (typeof entry?.userName !== 'string' || typeof entry.password !== 'string') throw new EdgeConfigError(`${file}: ${ref} needs userName and password`);
    out.set(ref, { userName: entry.userName, password: entry.password });
  }
  return out;
}
