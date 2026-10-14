/**
 * Webhook signatures in the Standard Webhooks scheme (docs/design/integration-v1.md §5.3).
 *
 *   webhook-id:        <event id>
 *   webhook-timestamp: <unix seconds of this attempt>
 *   webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")> [ v1,<…previous secret…>]
 *
 * The HMAC key is the base64-decoded part of `whsec_<base64>`. Why this scheme: receivers in Java / C# / Python find
 * ready verifiers for it, and the timestamp inside the signed text stops an old captured request from being replayed.
 * Important: the body is serialised **once**; the same bytes are signed and sent. Re-serialising after signing (key
 *    order, spacing) breaks every signature in a way that looks like a wrong secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';
/** Receivers should refuse timestamps further away than this (the reference receiver does) */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** HMAC key bytes of a `whsec_…` secret. A secret without the prefix is used as base64 as well */
export function secretKeyBytes(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
}

/** `v1,<base64>` for one secret */
export function signature(secret: string, id: string, timestamp: number, body: Buffer | string): string {
  const mac = createHmac('sha256', secretKeyBytes(secret));
  mac.update(`${id}.${timestamp}.`, 'utf8');
  mac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return `v1,${mac.digest('base64')}`;
}

/** The three signature headers. During a rotation both secrets sign, current first */
export function signatureHeaders(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  body: Buffer,
): { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string } {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((secret) => signature(secret, id, timestamp, body)).join(' '),
  };
}

/**
 * Receiver-side check, used by the test-delivery route and kept identical to examples/webhook-receiver.mjs.
 * True when any `v1,` signature in the header matches any of `secrets` and the timestamp is within the tolerance.
 */
export function verifySignature(options: {
  secrets: readonly string[];
  id: string;
  timestamp: string;
  signatureHeader: string;
  body: Buffer | string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const timestamp = Number(options.timestamp);
  if (!/^\d+$/.test(options.timestamp)) return false;
  if (Math.abs(options.nowSeconds - timestamp) > (options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const given = options.signatureHeader
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .map((part) => Buffer.from(part.slice(3), 'base64'));
  for (const secret of options.secrets) {
    const expected = Buffer.from(signature(secret, options.id, timestamp, options.body).slice(3), 'base64');
    if (given.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected))) return true;
  }
  return false;
}
