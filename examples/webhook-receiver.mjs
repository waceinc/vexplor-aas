#!/usr/bin/env node
/**
 * Reference webhook receiver for VEXPLOR AAS Studio events (docs/design/integration-v1.md §5.3). No dependencies.
 *
 *   WEBHOOK_SECRET=whsec_... [WEBHOOK_PREVIOUS_SECRET=whsec_...] [PORT=9000] node examples/webhook-receiver.mjs
 *
 * What a receiver must do, in this order:
 *  1. Verify `webhook-signature` = v1,base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>")) where
 *     key = base64-decoded part of the `whsec_` secret. Accept any of the space-separated signatures and either secret
 *     (during a rotation both are sent for 24 h).
 *  2. Refuse timestamps more than 5 minutes away — a captured request cannot be replayed later.
 *  3. Deduplicate on `webhook-id` (= CloudEvents `id`) for at least 48 h — delivery is at-least-once.
 *  4. Answer 2xx quickly; do the work afterwards. 410 tells the sender to stop for good.
 * Verify against the **raw bytes** of the body — re-serialising parsed JSON changes them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const TOLERANCE_SECONDS = 5 * 60;
const DEDUPE_MS = 48 * 3600 * 1000;

function sign(secret, id, timestamp, body) {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
}

/** true when one of the signatures matches one of the secrets and the timestamp is fresh */
export function verify({ secrets, id, timestamp, signatures, body, nowSeconds }) {
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const given = (signatures ?? '').split(' ').filter((s) => s.startsWith('v1,')).map((s) => Buffer.from(s.slice(3), 'base64'));
  return secrets.some((secret) => {
    const expected = sign(secret, id, timestamp, body);
    return given.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
  });
}

/** A request handler; `onEvent(event)` gets each verified, first-seen CloudEvent */
export function createReceiver({ secrets, onEvent = () => {}, now = Date.now }) {
  const seen = new Map(); // webhook-id -> first seen (ms)
  return (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const id = request.headers['webhook-id'];
      const ok = verify({
        secrets,
        id,
        timestamp: request.headers['webhook-timestamp'],
        signatures: request.headers['webhook-signature'],
        body,
        nowSeconds: Math.floor(now() / 1000),
      });
      if (!ok) {
        response.writeHead(401).end('bad signature');
        return;
      }
      for (const [key, at] of seen) if (now() - at > DEDUPE_MS) seen.delete(key);
      if (seen.has(id)) {
        response.writeHead(200).end('duplicate');
        return;
      }
      seen.set(id, now());
      response.writeHead(204).end();
      onEvent(JSON.parse(body.toString('utf8')));
    });
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const secrets = [process.env.WEBHOOK_SECRET, process.env.WEBHOOK_PREVIOUS_SECRET].filter(Boolean);
  if (secrets.length === 0) {
    console.error('Set WEBHOOK_SECRET to the whsec_ value shown when the subscription was created.');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 9000);
  const onEvent = (event) => console.log(`${event.time} ${event.type} ${event.subject ?? ''} seq=${event.sequence}`);
  createServer(createReceiver({ secrets, onEvent })).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
