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
