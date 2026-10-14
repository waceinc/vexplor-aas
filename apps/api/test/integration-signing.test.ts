/**
 * Webhook signatures and secret sealing (design §5.3, §5.6; MES D, platform 7.3, CMMS T16).
 *
 * The vectors are frozen: changing the signing scheme breaks every receiver in the field, so it must break this test.
 * One vector is the example published with the Standard Webhooks scheme (svix) — it pins that our reading of the
 * scheme (`whsec_` = base64 key, signed text `id.timestamp.body`) is the one receivers implement.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMasterKey, newSigningSecret, SecretBox, secretHint } from '../src/integration/secrets.js';
import { signature, signatureHeaders, verifySignature } from '../src/integration/signing.js';
import { KEY } from './helpers/integration-scenarios.js';

const SECRET = 'whsec_KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=';
const ID = 'evt_3K7Q9ZB2M4XH8V0TQW5N6R1JPC';
const TS = 1760406067;
const BODY = Buffer.from('{"specversion":"1.0","id":"evt_3K7Q9ZB2M4XH8V0TQW5N6R1JPC"}');
const FROZEN = 'v1,9T6LMlFWr/Ln+OaLffxZQ0h6f4PYWJ9XN/zVwdS0BWo=';

/** Independent implementation — written from the scheme text, shares no code with signing.ts */
function independent(secret: string, id: string, timestamp: number, body: Buffer): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return 'v1,' + createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body])).digest('base64');
}

describe('signature vectors', () => {
  it('frozen vector', () => {
    expect(signature(SECRET, ID, TS, BODY)).toBe(FROZEN);
    expect(independent(SECRET, ID, TS, BODY)).toBe(FROZEN);
  });

  it('the Standard Webhooks published example', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    expect(signature(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  it('headers carry id, timestamp and one signature per secret (current first)', () => {
    const previous = newSigningSecret();
    const headers = signatureHeaders([SECRET, previous], ID, TS, BODY);
    expect(headers['webhook-id']).toBe(ID);
    expect(headers['webhook-timestamp']).toBe(String(TS));
    expect(headers['webhook-signature'].split(' ')).toEqual([FROZEN, independent(previous, ID, TS, BODY)]);
  });
});

describe('verification', () => {
  const base = { secrets: [SECRET], id: ID, timestamp: String(TS), signatureHeader: FROZEN, body: BODY, nowSeconds: TS + 10 };

  it('accepts the genuine request', () => {
    expect(verifySignature(base)).toBe(true);
  });

  it.each([
    ['tampered body', { body: Buffer.from(BODY.toString().replace('1.0', '2.0')) }],
    ['tampered timestamp', { timestamp: String(TS + 1) }],
    ['tampered id', { id: 'evt_OTHER' }],
    ['wrong secret', { secrets: [newSigningSecret()] }],
    ['stale timestamp (> 5 min)', { nowSeconds: TS + 301 }],
    ['future timestamp (> 5 min)', { nowSeconds: TS - 301 }],
    ['non-numeric timestamp', { timestamp: '17604060e1' }],
    ['other scheme only', { signatureHeader: FROZEN.replace('v1,', 'v2,') }],
  ])('rejects %s', (_name, patch) => {
    expect(verifySignature({ ...base, ...patch })).toBe(false);
  });

  it('during a rotation either secret verifies; after it, the old one alone does not', () => {
    const fresh = newSigningSecret();
    const both = signatureHeaders([fresh, SECRET], ID, TS, BODY)['webhook-signature'];
    expect(verifySignature({ ...base, signatureHeader: both, secrets: [SECRET] })).toBe(true);
    expect(verifySignature({ ...base, signatureHeader: both, secrets: [fresh] })).toBe(true);
    const afterWindow = signatureHeaders([fresh], ID, TS, BODY)['webhook-signature'];
    expect(verifySignature({ ...base, signatureHeader: afterWindow, secrets: [SECRET] })).toBe(false);
  });
});

describe('reference receiver (examples/webhook-receiver.mjs)', () => {
  type Receiver = {
    verify: (input: { secrets: string[]; id: string; timestamp: string; signatures: string; body: Buffer; nowSeconds: number }) => boolean;
    createReceiver: (options: { secrets: string[]; onEvent?: (event: unknown) => void; now?: () => number }) => (req: unknown, res: unknown) => void;
  };
  const load = async (): Promise<Receiver> => (await import(new URL('../../../examples/webhook-receiver.mjs', import.meta.url).href)) as Receiver;

  it('verifies like the server signs, rejects tampering', async () => {
    const { verify } = await load();
    expect(verify({ secrets: [SECRET], id: ID, timestamp: String(TS), signatures: FROZEN, body: BODY, nowSeconds: TS })).toBe(true);
    expect(verify({ secrets: [SECRET], id: ID, timestamp: String(TS), signatures: FROZEN, body: Buffer.from('{}'), nowSeconds: TS })).toBe(false);
  });

  it('dedupes on webhook-id and rejects bad signatures with 401', async () => {
    const { createReceiver } = await load();
    const seen: unknown[] = [];
    const handler = createReceiver({ secrets: [SECRET], onEvent: (event) => seen.push(event), now: () => TS * 1000 });
    const call = (signatures: string) =>
      new Promise<number>((resolve) => {
        const listeners: Record<string, ((chunk?: Buffer) => void)[]> = {};
        const req = {
          headers: { 'webhook-id': ID, 'webhook-timestamp': String(TS), 'webhook-signature': signatures },
          on: (name: string, listener: (chunk?: Buffer) => void) => void (listeners[name] = [...(listeners[name] ?? []), listener]),
        };
        const res = { writeHead: (status: number) => ({ end: () => resolve(status) }) };
        handler(req, res);
        listeners['data']?.forEach((listener) => listener(BODY));
        listeners['end']?.forEach((listener) => listener());
      });
    expect(await call(FROZEN)).toBe(204);
    expect(await call(FROZEN)).toBe(200);
    expect(await call('v1,AAAA')).toBe(401);
    expect(seen).toHaveLength(1);
  });
});

describe('secret sealing (AES-256-GCM)', () => {
  it('round-trips and carries the key id', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('whsec_abc');
    expect(sealed.startsWith(`${box.keyId}:`)).toBe(true);
    expect(sealed).not.toContain('whsec_abc');
    expect(box.open(sealed)).toBe('whsec_abc');
  });

  it('a different key or an altered value does not open', () => {
    const sealed = new SecretBox(KEY).seal('secret');
    expect(() => new SecretBox(Buffer.alloc(32, 9)).open(sealed)).toThrow();
    const [keyId, payload] = sealed.split(':') as [string, string];
    const raw = Buffer.from(payload, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => new SecretBox(KEY).open(`${keyId}:${raw.toString('base64')}`)).toThrow();
  });

  it('master key: env > folder file (0600) > memory ephemeral; PostgreSQL without key is missing', () => {
    const env = { AAS_SECRET_KEY: KEY.toString('base64') };
    expect(loadMasterKey({ env, storeKind: 'postgres' }).source).toBe('env');
    expect(loadMasterKey({ env: {}, storeKind: 'postgres' })).toEqual({ box: undefined, source: 'missing' });
    expect(loadMasterKey({ env: {}, storeKind: 'memory' }).source).toBe('ephemeral');
    const dir = mkdtempSync(join(tmpdir(), 'aas-key-'));
    const first = loadMasterKey({ env: {}, storeKind: 'folder', dataDir: dir });
    const second = loadMasterKey({ env: {}, storeKind: 'folder', dataDir: dir });
    expect(first.source).toBe('file');
    expect(second.box!.open(first.box!.seal('x'))).toBe('x');
    if (process.platform !== 'win32') expect(statSync(first.file!).mode & 0o777).toBe(0o600);
  });

  it('an invalid AAS_SECRET_KEY is a startup error', () => {
    expect(() => loadMasterKey({ env: { AAS_SECRET_KEY: 'short' }, storeKind: 'memory' })).toThrow(/AAS_SECRET_KEY/);
    expect(() => loadMasterKey({ env: { AAS_SECRET_KEY: Buffer.alloc(31).toString('base64') }, storeKind: 'memory' })).toThrow();
  });

  it('new secrets are whsec_ + 32 random bytes; the hint is the last 4 chars', () => {
    const secret = newSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(secretHint(secret)).toBe(secret.slice(-4));
  });
});
