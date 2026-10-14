/**
 * The webhook sender against a real local HTTP server (design §5.3; MES C, platform 7.3).
 * The connection is pinned to 127.0.0.1 — the egress check is tested separately (integration-egress.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { judgeAttempt, retryDelayMs, RETRY_SCHEDULE_MS } from '../src/integration/delivery-policy.js';
import { cleanError, retryAfterMs, sendWebhook } from '../src/integration/webhook.js';
import { startReceiver } from './helpers/integration-scenarios.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function receiver(respond: Parameters<typeof startReceiver>[0]) {
  const started = await startReceiver(respond);
  closers.push(started.close);
  return started;
}

const attempt = (port: number, path = '/hook') => ({
  url: `http://mes.example.com:${port}${path}`,
  address: '127.0.0.1',
  body: Buffer.from('{"specversion":"1.0"}'),
  headers: { 'webhook-id': 'evt_1', 'webhook-timestamp': '1', 'webhook-signature': 'v1,x' },
});

describe('sendWebhook', () => {
  it('posts the exact body with CloudEvents content type and the product user agent', async () => {
    const server = await receiver(() => ({ status: 200, body: 'ok' }));
    const outcome = await sendWebhook(attempt(server.port));
    expect(outcome).toMatchObject({ statusCode: 200, snippet: 'ok', address: '127.0.0.1' });
    const received = server.requests[0]!;
    expect(received.method).toBe('POST');
    expect(received.body.toString()).toBe('{"specversion":"1.0"}');
    expect(received.headers['content-type']).toBe('application/cloudevents+json; charset=utf-8');
    expect(received.headers['user-agent']).toMatch(/^VEXPLOR-AAS-Webhook\//);
    expect(received.headers['webhook-id']).toBe('evt_1');
  });

  it('Important: does not follow a redirect — not even to the metadata service', async () => {
    const server = await receiver(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    const outcome = await sendWebhook(attempt(server.port));
    expect(outcome.statusCode).toBe(302);
    expect(outcome.location).toBe('http://169.254.169.254/latest/meta-data');
    expect(outcome.error).toMatch(/redirect 302 not followed/);
    expect(server.requests).toHaveLength(1);
    expect(judgeAttempt({ attempts: 1, statusCode: 302, error: outcome.error! }, () => 0.5).outcome).toBe('dead');
  });

  it('gives up at the deadline when the receiver hangs', async () => {
    const server = await receiver(() => 'hang');
    const outcome = await sendWebhook({ ...attempt(server.port), timeoutMs: 150 });
    expect(outcome.statusCode).toBeUndefined();
    expect(outcome.error).toMatch(/timeout/);
  });

  it('reads at most 64 KB and reports at most 1 KB of the response', async () => {
    const server = await receiver(() => ({ status: 200, body: 'x'.repeat(300_000) }));
    const outcome = await sendWebhook(attempt(server.port));
    expect(outcome.statusCode).toBe(200);
    expect(outcome.snippet.length).toBeLessThanOrEqual(1024);
  });

  it('a refused connection is an error without status (retried)', async () => {
    const server = await receiver(() => ({ status: 200 }));
    await server.close();
    closers.pop();
    const outcome = await sendWebhook(attempt(server.port));
    expect(outcome.statusCode).toBeUndefined();
    expect(outcome.error).toMatch(/ECONNREFUSED/);
    expect(judgeAttempt({ attempts: 1, error: outcome.error! }, () => 0.5).outcome).toBe('retry');
  });

  it('reports Retry-After', async () => {
    const server = await receiver(() => ({ status: 429, headers: { 'retry-after': '7' } }));
    expect((await sendWebhook(attempt(server.port))).retryAfterMs).toBe(7000);
  });
});

describe('outcome policy', () => {
  const fixed = () => 0.5;

  it.each([
    [200, 'succeeded'],
    [204, 'succeeded'],
    [408, 'retry'],
    [425, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [400, 'dead'],
    [401, 'dead'],
    [404, 'dead'],
    [410, 'dead'],
  ])('HTTP %i → %s', (statusCode, outcome) => {
    expect(judgeAttempt({ attempts: 1, statusCode }, fixed).outcome).toBe(outcome);
  });

  it('410 also disables the subscription', () => {
    expect(judgeAttempt({ attempts: 1, statusCode: 410 }, fixed)).toEqual({ outcome: 'dead', disableReason: '410 from receiver' });
  });

  it('schedule: 12 attempts, ±20 % jitter, then dead', () => {
    expect(RETRY_SCHEDULE_MS).toHaveLength(12);
    for (let attempts = 1; attempts < 12; attempts++) {
      const base = RETRY_SCHEDULE_MS[attempts]!;
      expect(retryDelayMs(attempts, () => 0)).toBe(Math.round(base * 0.8));
      expect(retryDelayMs(attempts, () => 1)).toBe(Math.round(base * 1.2));
    }
    expect(retryDelayMs(12, () => 0.5)).toBeUndefined();
    expect(judgeAttempt({ attempts: 12, statusCode: 500 }, fixed).outcome).toBe('dead');
  });

  it('Retry-After is honoured and capped at one hour', () => {
    expect(judgeAttempt({ attempts: 1, statusCode: 429, retryAfterMs: 7000 }, fixed)).toEqual({ outcome: 'retry', delayMs: 7000 });
    expect(judgeAttempt({ attempts: 1, statusCode: 503, retryAfterMs: 99_999_000 }, fixed)).toEqual({ outcome: 'retry', delayMs: 3_600_000 });
  });

  it('Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    expect(retryAfterMs('Wed, 14 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
  });

  it('error text loses control characters and is capped', () => {
    expect(cleanError('a\r\nb\u0000c')).toBe('a b c');
    expect(cleanError('x'.repeat(5000))).toHaveLength(1024);
  });
});
