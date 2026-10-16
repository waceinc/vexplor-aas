/**
 * Request signing of the edge contract (docs/edge-contract.md §2).
 *
 * Every edge request is signed with the device's Ed25519 key over seven lines: the contract name, method, path with
 * query, timestamp, nonce, device and the SHA-256 of the body bytes. The body hash and the path — not the TLS session —
 * are signed, so a signature survives a TLS-inspecting proxy on the factory side.
 *
 * Important: the body hash is taken over `rawBody`, the bytes as received. Hashing a re-serialised JSON value would
 *    differ from what the edge signed by a single space and reject every request.
 * Important: replay. A timestamp outside ±300 s is refused, and a nonce seen from the same device in the last 10 minutes
 *    is refused. The nonce memory is per process — the batch idempotency key still stops a replayed batch from being
 *    stored twice after a restart.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export const EDGE_CONTRACT = 'vexplor.edge/1';
export const CLOCK_SKEW_SECONDS = 300;
const NONCE_WINDOW_MS = 10 * 60 * 1000;
/** Nonces remembered at most — past it the oldest go first; the timestamp window still bounds a replay (review L) */
const NONCES_KEPT = 200_000;
/** SubjectPublicKeyInfo prefix for an Ed25519 key (RFC 8410) — followed by the 32 raw key bytes */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignedHeaders {
  device: string;
  timestamp: number;
  nonce: string;
  signature: Buffer;
}

export type SignatureFailure = 'SignatureInvalid' | 'ClockSkew';

/** The four signing headers, or undefined when one is missing or malformed */
export function signedHeaders(headers: Record<string, string>): SignedHeaders | undefined {
  const device = headers['x-edge-device'];
  const timestamp = Number(headers['x-edge-timestamp']);
  const nonce = headers['x-edge-nonce'];
  const signature = /^ed25519=([A-Za-z0-9_-]+)$/.exec(headers['x-edge-signature'] ?? '')?.[1];
  if (!device || device.length > 64 || !Number.isInteger(timestamp) || !nonce || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce) || !signature) return undefined;
  const bytes = Buffer.from(signature, 'base64url');
  return bytes.length === 64 ? { device, timestamp, nonce, signature: bytes } : undefined;
}

export function bodyHash(rawBody: Uint8Array | undefined): string {
  return createHash('sha256').update(rawBody ?? new Uint8Array()).digest('hex');
}

/** The seven signed lines */
export function signedText(method: string, pathAndQuery: string, headers: SignedHeaders, rawBody: Uint8Array | undefined): string {
  return [EDGE_CONTRACT, method.toUpperCase(), pathAndQuery, String(headers.timestamp), headers.nonce, headers.device, bodyHash(rawBody)].join('\n');
}

/** A 32-byte raw Ed25519 public key in base64url, or undefined when it is not one */
export function publicKeyOf(base64url: string): KeyObject | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(base64url)) return undefined;
  const raw = Buffer.from(base64url, 'base64url');
  if (raw.length !== 32) return undefined;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return undefined;
  }
}

/** Checks the signature, the clock and the nonce. `now` in milliseconds */
export class SignatureVerifier {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  check(key: KeyObject, text: string, headers: SignedHeaders): SignatureFailure | undefined {
    if (!verify(null, Buffer.from(text), key, headers.signature)) return 'SignatureInvalid';
    if (Math.abs(this.now() / 1000 - headers.timestamp) > CLOCK_SKEW_SECONDS) return 'ClockSkew';
    // Only a correctly signed request reaches the nonce memory. Self-signed register requests do too — so the memory is
    //    capped, and registration is rate-limited before the signature check (routes-edge.ts)
    this.forgetOld();
    const seen = `${headers.device}\n${headers.nonce}`;
    if (this.nonces.has(seen)) return 'SignatureInvalid';
    this.nonces.set(seen, this.now());
    while (this.nonces.size > NONCES_KEPT) this.nonces.delete(this.nonces.keys().next().value!);
    return undefined;
  }

  private forgetOld(): void {
    const cutoff = this.now() - NONCE_WINDOW_MS;
    for (const [nonce, at] of this.nonces) {
      if (at >= cutoff) break; // insertion order = time order
      this.nonces.delete(nonce);
    }
  }
}
