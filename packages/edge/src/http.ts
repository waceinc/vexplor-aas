/**
 * Signed requests to the server (docs/edge-contract.md §2, §7) — the edge's only outbound connection.
 *
 * Every request carries X-Edge-Device, X-Edge-Timestamp, X-Edge-Nonce and an Ed25519 signature over seven lines: the
 * contract name, method, path with query, timestamp, nonce, device and the SHA-256 of the exact body bytes.
 *
 * Important: through a proxy, an HTTP CONNECT tunnel to the server's host by name, then TLS end to end over it — the
 *    proxy carries bytes and cannot read or change a batch. Allow-lists on the proxy name the server host.
 * Important: no redirects are followed — a 3xx is an answer like any other, never a reason to send a batch elsewhere.
 */
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export const CONTRACT = 'vexplor.edge/1';
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface EdgeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface EdgeHttpOptions {
  server: string;
  /** http://[user:pass@]host:port */
  proxy?: string;
  /** PEM of a private CA the server certificate is issued by */
  ca?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface Signer {
  device: string;
  key: KeyObject;
}

export function signerOf(device: string, privateKeyPem: string): Signer {
  return { device, key: createPrivateKey(privateKeyPem) };
}

/** The seven signed lines (contract §2) */
export function signedText(method: string, target: string, timestamp: number, nonce: string, device: string, body: Uint8Array): string {
  return [CONTRACT, method, target, String(timestamp), nonce, device, createHash('sha256').update(body).digest('hex')].join('\n');
}

function tunnel(proxyUrl: URL, authority: string, timeoutMs: number): Promise<Socket> {
  const user = decodeURIComponent(proxyUrl.username);
  const authorization = user ? `Basic ${Buffer.from(`${user}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}` : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxyUrl.hostname,
      port: proxyUrl.port === '' ? 80 : Number(proxyUrl.port),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
      agent: false,
      timeout: timeoutMs,
    });
    request.on('connect', (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT ${authority}: ${response.statusCode ?? 0}`));
      }
    });
    request.on('timeout', () => request.destroy(new Error(`proxy did not answer in ${timeoutMs} ms`)));
    request.on('error', reject);
    request.end();
  });
}

export class EdgeHttp {
  private readonly server: URL;
  private readonly proxy: URL | undefined;

  constructor(private readonly options: EdgeHttpOptions) {
    this.server = new URL(options.server);
    this.proxy = options.proxy ? new URL(options.proxy) : undefined;
  }

  /** One signed request; resolves with any HTTP answer, rejects only when no answer arrived */
  async request(signer: Signer, method: string, target: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<EdgeResponse> {
    const bytes = body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(body));
    const timestamp = Math.floor((this.options.now ?? Date.now)() / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const signature = sign(null, Buffer.from(signedText(method, target, timestamp, nonce, signer.device, bytes)), signer.key).toString('base64url');
    const headers: Record<string, string> = {
      'x-edge-device': signer.device,
      'x-edge-timestamp': String(timestamp),
      'x-edge-nonce': nonce,
      'x-edge-signature': `ed25519=${signature}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes.length) }),
      ...extraHeaders,
    };
    return this.send(new URL(target, this.server), method, headers, bytes);
  }

  /** An unsigned GET of another https address through the same proxy — the update manifest (update.ts) */
  async getJson(address: string): Promise<EdgeResponse> {
    const url = new URL(address);
    if (url.protocol !== 'https:') throw new Error(`not https: ${address}`);
    return this.send(url, 'GET', {}, new Uint8Array());
  }

  private async send(url: URL, method: string, headers: Record<string, string>, bytes: Uint8Array): Promise<EdgeResponse> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const tls = url.protocol === 'https:';
    let agent: HttpsAgent | false = false;
    if (this.proxy && tls) {
      const port = url.port === '' ? 443 : Number(url.port);
      const socket = await tunnel(this.proxy, `${url.hostname}:${port}`, timeoutMs);
      const secure = tlsConnect({ socket, servername: url.hostname, ...(this.options.ca ? { ca: this.options.ca } : {}) });
      agent = new HttpsAgent({ keepAlive: false });
      agent.createConnection = () => secure;
    }
    const send = tls ? httpsRequest : httpRequest;
    return new Promise<EdgeResponse>((resolve, reject) => {
      const request = send(url, { method, headers, agent, timeout: timeoutMs, ...(tls && this.options.ca && !this.proxy ? { ca: this.options.ca } : {}) });
      request.on('timeout', () => request.destroy(new Error(`no answer in ${timeoutMs} ms`)));
      request.on('error', reject);
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = raw === '' ? undefined : JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[key] = value;
          resolve({ status: response.statusCode ?? 0, headers, body: parsed });
        });
        response.on('error', reject);
      });
      request.end(bytes);
    });
  }
}
