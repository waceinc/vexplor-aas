/**
 * One webhook attempt over node:http / node:https (docs/design/integration-v1.md §5.3).
 *
 * - The connection goes to the address the egress check pinned (`lookup`), the Host header and TLS name stay the host.
 * - One total deadline (`INTEGRATION_TIMEOUT_MS`, default 10 s) covers connect, send and response.
 * - Redirects are **not** followed: a 3xx is a failure and its `Location` is reported — following one would let a
 *   receiver send this server somewhere the egress check never saw (the classic 302 → 169.254.169.254).
 * - At most 64 KB of the response is read; the rest is discarded.
 * - Through a proxy (`INTEGRATION_PROXY`): an HTTP CONNECT tunnel to `host:port` by name, then TLS over the tunnel with
 *   the certificate checked against the host — the proxy carries bytes and never sees the content (egress.ts rule 8).
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { PRODUCT_VERSION } from '@aas/core';

import { CLOUDEVENTS_CONTENT_TYPE } from './cloudevents.js';
import { pinnedLookup } from './egress.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface WebhookAttempt {
  url: string;
  /** Pinned address from the egress check */
  address: string;
  body: Buffer;
  /** The signature headers (webhook-id, webhook-timestamp, webhook-signature) */
  headers: Record<string, string>;
  timeoutMs?: number;
  /** Tunnel through this proxy (egress check result) — https only */
  proxy?: { host: string; port: number; authorization?: string };
  /** Extra trusted CA (PEM) — a receiver with a private certificate authority */
  ca?: string;
}

/** Opens a CONNECT tunnel to `authority` through the proxy; rejects with the proxy's status when it refuses */
function openTunnel(proxy: NonNullable<WebhookAttempt['proxy']>, authority: string): { socket: Promise<Socket>; abort: (error: Error) => void } {
  const request = httpRequest({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: authority,
    headers: { host: authority, ...(proxy.authorization ? { 'proxy-authorization': proxy.authorization } : {}) },
    agent: false,
  });
  const socket = new Promise<Socket>((resolve, reject) => {
    request.on('connect', (response: IncomingMessage, tunnel: Socket) => {
      if (response.statusCode === 200) resolve(tunnel);
      else {
        tunnel.destroy();
        reject(new Error(`proxy refused CONNECT ${authority}: ${response.statusCode ?? 0}`));
      }
    });
    request.on('error', (error: Error & { code?: string }) => reject(new Error(`proxy ${proxy.host}:${proxy.port}: ${error.code ?? error.name}: ${error.message}`)));
  });
  request.end();
  return { socket, abort: (error) => request.destroy(error) };
}

export interface WebhookOutcome {
  /** Absent when no response arrived (network error, timeout) */
  statusCode?: number;
  durationMs: number;
  address: string;
  /** Error class and message, control characters removed, at most 1 KB */
  error?: string;
  /** From `Retry-After` (seconds or HTTP date), in ms */
  retryAfterMs?: number;
  /** First bytes of the response as text, at most 1 KB */
  snippet: string;
  location?: string;
}

/** Control characters out, length capped — error text ends up in delivery rows and on screen */
export function cleanError(text: string, max = 1024): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** `Retry-After: 7` or `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT` → ms from `now`; undefined when absent or unreadable */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function sendWebhook(attempt: WebhookAttempt, now: () => number = Date.now): Promise<WebhookOutcome> {
  const started = now();
  const timeoutMs = attempt.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = new URL(attempt.url);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<WebhookOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: Omit<WebhookOutcome, 'durationMs' | 'address'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...outcome, durationMs: Math.max(0, now() - started), address: attempt.address });
    };

    const headers = {
      ...attempt.headers,
      'content-type': CLOUDEVENTS_CONTENT_TYPE,
      'content-length': String(attempt.body.length),
      'user-agent': `VEXPLOR-AAS-Webhook/${PRODUCT_VERSION}`,
    };
    let abort: (error: Error) => void = () => undefined;
    const deadline = setTimeout(() => abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);

    if (attempt.proxy) {
      if (url.protocol !== 'https:') {
        finish({ error: 'only https webhooks go through the proxy', snippet: '' });
        return;
      }
      const tunnel = openTunnel(attempt.proxy, `${host.includes(':') ? `[${host}]` : host}:${port}`);
      abort = tunnel.abort;
      tunnel.socket.then(
        (socket) => {
          if (settled) {
            socket.destroy();
            return;
          }
          // TLS over the tunnel, certificate checked against the host name — end to end, the proxy sees bytes only
          const tls = tlsConnect({ socket, servername: host, ...(attempt.ca ? { ca: attempt.ca } : {}) });
          tls.on('error', (error: Error & { code?: string }) => finish({ error: cleanError(`${error.code ?? error.name}: ${error.message}`), snippet: '' }));
          // A one-off agent that hands out the tunnel — `agent: false` would make a fresh default agent that dials itself
          const agent = new HttpsAgent({ keepAlive: false });
          agent.createConnection = () => tls;
          const req = httpsRequest(url, { method: 'POST', headers, agent });
          abort = (error) => req.destroy(error);
          wire(req);
        },
        (error: Error) => finish({ error: cleanError(error.message), snippet: '' }),
      );
      return;
    }

    const req = send(url, {
      method: 'POST',
      lookup: pinnedLookup(attempt.address),
      headers,
      ...(attempt.ca ? { ca: attempt.ca } : {}),
      // No connection reuse — every attempt re-checks egress and pins a fresh address
      agent: false,
    });
    abort = (error) => req.destroy(error);
    wire(req);

    /** Response handling, the same for a direct request and one through the tunnel */
    function wire(req: ReturnType<typeof httpRequest>): void {
      req.on('error', (error: Error & { code?: string }) => {
        finish({ error: cleanError(`${error.code ?? error.name}: ${error.message}`), snippet: '' });
      });

      req.on('response', (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          const room = MAX_RESPONSE_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          // Enough read — stop the receiver from streaming more into us
          if (size >= MAX_RESPONSE_BYTES) response.destroy();
        });
        const done = (): void => {
          const statusCode = response.statusCode ?? 0;
          const location = response.headers.location;
          const retryAfter = retryAfterMs(response.headers['retry-after'] as string | undefined, now());
          finish({
            statusCode,
            snippet: cleanError(Buffer.concat(chunks).toString('utf8'), 1024),
            ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
            ...(location === undefined ? {} : { location: cleanError(location, 512) }),
            ...(statusCode >= 300 && statusCode < 400 ? { error: cleanError(`redirect ${statusCode} not followed: ${location ?? ''}`) } : {}),
          });
        };
        response.on('end', done);
        response.on('close', done);
        response.on('error', done);
      });

      req.end(attempt.body);
    }
  });
}
