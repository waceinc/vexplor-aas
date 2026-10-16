/**
 * Order and retention of the local queue (Logic Studio's requests, 2026-10-16): batches go out oldest first, never two
 * at once — a realtime batch must not overtake the backlog, or the receiver files the backlog as "late" — and a batch
 * older than maxQueueDays is dropped and counted.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { DiskQueue, Sender, type Batch, type EdgeHttp } from '../src/index.js';

const batch = (seq: number, createdAt: string): Batch => ({
  schema: 'vexplor.edge.batch/1',
  bootId: '7f1d2c3e-0a4b-4c5d-8e6f-112233445566',
  seq,
  readListRevision: '1',
  createdAt,
  samples: [],
});

function slowServer(sent: number[]) {
  let inFlight = 0;
  let overlap = false;
  const http = {
    async request(_signer: unknown, _method: string, _target: string, body: Batch) {
      inFlight += 1;
      if (inFlight > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent.push(body.seq);
      inFlight -= 1;
      return { status: 200, headers: {}, body: { accepted: 0, rejected: [], duplicate: false } };
    },
  } as unknown as EdgeHttp;
  return { http, overlapped: () => overlap };
}

describe('edge queue order and retention', () => {
  it('sends oldest first and never two at once, even when flushes overlap', async () => {
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-order-')), 1000);
    for (let seq = 1; seq <= 5; seq += 1) queue.add(batch(seq, `2026-10-16T00:00:0${seq}.000Z`));
    const sent: number[] = [];
    const server = slowServer(sent);
    const sender = new Sender(server.http, queue, () => ({ device: 'dev_x', key: undefined as never }));
    // A realtime batch arrives while the backlog is being sent, and a second flush starts meanwhile
    const first = sender.flush();
    queue.add(batch(6, '2026-10-16T00:00:09.000Z'));
    const second = sender.flush();
    await Promise.all([first, second]);
    await sender.flush();
    expect(server.overlapped()).toBe(false);
    expect(sent).toEqual([1, 2, 3, 4, 5, 6]);
    expect(queue.size).toBe(0);
  });

  it('drops batches older than maxQueueDays and counts them', () => {
    const now = Date.parse('2026-10-16T00:00:00.000Z');
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-age-')), 1000, 30, () => now);
    queue.add(batch(1, '2026-09-10T00:00:00.000Z')); // 36 days old
    queue.add(batch(2, '2026-10-01T00:00:00.000Z')); // 15 days old
    expect(queue.files().map((name) => queue.read(name).seq)).toEqual([2]);
    expect(queue.dropped).toBe(1);
  });
});

describe('what stops sending', () => {
  const answering = (status: number, code?: string) =>
    ({ request: async () => ({ status, headers: {}, body: code ? { code } : undefined }) }) as unknown as EdgeHttp;
  const queued = () => {
    const queue = new DiskQueue(mkdtempSync(join(tmpdir(), 'edge-stop-')), 100);
    queue.add(batch(1, new Date().toISOString()));
    return queue;
  };

  it('only the contract says so: 401 (not ClockSkew) and 403 stop; the batch stays queued', async () => {
    for (const [status, code] of [[401, 'UnknownDevice'], [401, 'SignatureInvalid'], [403, 'DeviceRevoked']] as const) {
      const queue = queued();
      expect((await new Sender(answering(status, code), queue, () => ({}) as never).flush()).state, `${status} ${code}`).toBe('stopped');
      expect(queue.size).toBe(1);
    }
  });

  it('an answer the contract does not name (a proxy or an upgrade in progress: 404, 405, 502 …) waits and tries again', async () => {
    // Found on a site test (2026-10-17): another server on the same address answered 404, the edge stopped for good
    for (const status of [404, 405, 408, 409, 502, 504]) {
      const queue = queued();
      const result = await new Sender(answering(status), queue, () => ({}) as never, () => 0.5).flush();
      expect(result.state, String(status)).toBe('wait');
      expect(queue.size).toBe(1);
    }
  });
});
