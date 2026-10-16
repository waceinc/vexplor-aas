/**
 * The remote collector's loop: register once, then poll the read list, read approved tags on their intervals, queue
 * batches on disk and send them signed (docs/edge-contract.md).
 *
 * Important: outbound only. Nothing here listens on a port; the server reaches the edge only through the read list it
 *    serves and the answers to batches. There is no command channel and no remote stop (STD-009 T10) — a revoked
 *    device stops by itself and keeps its queue.
 * Important: an outage costs no samples. Reading goes on while the server is unreachable; batches wait on disk and are
 *    sent in order with the same bootId and seq once it answers (the server stores each once).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PRODUCT_VERSION } from '@aas/core';
import type { ProtocolReader } from '@aas/collector';
import type { EdgeConfig } from './config.js';
import { EdgeHttp, signerOf, type Signer } from './http.js';
import { loadOrCreateIdentity, saveIdentity, type Identity } from './identity.js';
import { DiskQueue, type Batch } from './queue.js';
import { intervalGroups, openReader, readGroup, type ReadListInterface, type Sample } from './readers.js';
import { Sender } from './sender.js';

export interface AgentOptions {
  config: EdgeConfig;
  credentials: Map<string, { userName: string; password: string }>;
  log?: (line: string) => void;
  now?: () => Date;
}

interface ReadList {
  revision: string;
  state: 'pending-approval' | 'approved' | 'paused';
  pollSeconds: number;
  interfaces: ReadListInterface[];
}

const HEARTBEAT_MS = 60_000;
const SOFTWARE = { name: 'vexplor-edge', version: PRODUCT_VERSION };

export class EdgeAgent {
  readonly bootId = randomUUID();
  readonly http: EdgeHttp;
  readonly queue: DiskQueue;
  readonly sender: Sender;
  identity: Identity;
  stopped: string | undefined;
  /** Samples read since start — what "nothing lost" is measured against */
  collected = 0;
  private seq = 0;
  private list: ReadList | undefined;
  private buffer: Sample[] = [];
  private readers: { iface: ReadListInterface; reader?: ProtocolReader; error?: string }[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private sendAfter = 0;
  private lastBatchAt = 0;
  private readonly startedAt: string;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: AgentOptions) {
    const { config } = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.startedAt = this.now().toISOString();
    this.identity = loadOrCreateIdentity(config.stateDir);
    this.http = new EdgeHttp({ server: config.server, ...(config.proxy ? { proxy: config.proxy } : {}), ...(config.caFile ? { ca: readFileSync(config.caFile, 'utf8') } : {}) });
    this.queue = new DiskQueue(config.stateDir, config.maxQueuedBatches);
    this.sender = new Sender(this.http, this.queue, () => this.signer());
  }

  private signer(): Signer {
    return signerOf(this.identity.deviceId ?? 'register', this.identity.privateKeyPem);
  }

  /** Registers with a one-time code (first run only) */
  async register(code: string): Promise<Identity> {
    if (this.identity.deviceId) return this.identity;
    const answer = await this.http.request(this.signer(), 'POST', '/edge/v1/register', {
      schema: 'vexplor.edge.register/1',
      code,
      publicKey: this.identity.publicKey,
      device: { name: this.options.config.name, software: SOFTWARE },
    });
    const body = answer.body as { deviceId?: string; registeredAt?: string; limits?: Identity['limits']; code?: string } | undefined;
    if (answer.status !== 201 || !body?.deviceId) throw new Error(`registration refused: ${answer.status} ${body?.code ?? ''}`.trim());
    this.identity = { ...this.identity, deviceId: body.deviceId, ...(body.registeredAt ? { registeredAt: body.registeredAt } : {}), ...(body.limits ? { limits: body.limits } : {}) };
    saveIdentity(this.options.config.stateDir, this.identity);
    return this.identity;
  }

  async start(): Promise<void> {
    if (!this.identity.deviceId) throw new Error('not registered — run register with a code first');
    await this.poll();
    this.flushTimer = setInterval(() => void this.tick(), this.options.config.flushIntervalMs);
  }

  async stop(reason = 'stopped'): Promise<void> {
    this.stopped ??= reason;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.closeReaders();
  }

  /** Fetches the read list (304 when unchanged) and rebuilds readers when it changed */
  async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const answer = await this.http.request(this.signer(), 'GET', '/edge/v1/read-list', undefined, this.list ? { 'if-none-match': `"${this.list.revision}"` } : {});
      if (answer.status === 200) {
        const next = answer.body as ReadList;
        if (next.revision !== this.list?.revision) await this.apply(next);
        this.list = next;
      } else if (answer.status === 401 || answer.status === 403) {
        await this.halt(`read list refused: ${answer.status} ${(answer.body as { code?: string } | undefined)?.code ?? ''}`.trim());
        return;
      }
    } catch (error) {
      this.log(`read list not reachable: ${(error as Error).message}`);
    }
    this.pollTimer = setTimeout(() => void this.poll(), (this.list?.pollSeconds ?? 60) * 1000);
  }

  private async apply(list: ReadList): Promise<void> {
    await this.closeReaders();
    this.log(`read list ${list.revision} (${list.state}): ${list.interfaces.length} interface(s)`);
    if (list.state !== 'approved') return;
    for (const iface of list.interfaces) {
      const slot: (typeof this.readers)[number] = { iface };
      this.readers.push(slot);
      try {
        slot.reader = await openReader(iface, { credentials: this.options.credentials, opcua: this.options.config.opcua });
      } catch (error) {
        slot.error = (error as Error).message.slice(0, 512);
        this.log(`${iface.interfaceId}: ${slot.error}`);
        continue;
      }
      for (const [every, tags] of intervalGroups(iface)) {
        let busy = false;
        this.timers.push(
          setInterval(() => {
            if (busy || !slot.reader) return;
            busy = true;
            readGroup(slot.reader, tags, this.now)
              .then((samples) => {
                this.collected += samples.length;
                this.buffer.push(...samples);
                slot.error = undefined;
              })
              .catch((error: Error) => (slot.error = error.message.slice(0, 512)))
              .finally(() => (busy = false));
          }, every),
        );
      }
    }
  }

  private async closeReaders(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.all(this.readers.map((slot) => slot.reader?.close().catch(() => undefined)));
    this.readers = [];
  }

  private async halt(reason: string): Promise<void> {
    this.log(`ALARM: ${reason} — sending stopped, the queue is kept`);
    await this.stop(reason);
  }

  /** Turns buffered samples into batches on disk, then sends what the server will take */
  async tick(): Promise<void> {
    if (this.stopped || !this.list) return;
    const at = this.now();
    const limit = this.identity.limits?.maxSamplesPerBatch ?? 5000;
    const samples = this.buffer.splice(0);
    const heartbeat = samples.length === 0 && at.getTime() - this.lastBatchAt >= HEARTBEAT_MS;
    for (let start = 0; start < samples.length || (heartbeat && start === 0); start += limit) {
      this.seq += 1;
      const batch: Batch = {
        schema: 'vexplor.edge.batch/1',
        bootId: this.bootId,
        seq: this.seq,
        readListRevision: this.list.revision,
        createdAt: at.toISOString(),
        samples: samples.slice(start, start + limit),
        status: this.status(),
      };
      this.queue.add(batch);
      this.lastBatchAt = at.getTime();
      if (heartbeat) break;
    }
    if (at.getTime() < this.sendAfter) return;
    const result = await this.sender.flush();
    if (result.state === 'wait') {
      this.sendAfter = at.getTime() + result.waitMs;
      this.log(`sending paused ${result.waitMs} ms: ${result.reason}`);
    } else if (result.state === 'stopped') {
      await this.halt(result.reason);
    }
    if (result.state !== 'stopped' && result.readListRevision && result.readListRevision !== this.list.revision) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      void this.poll();
    }
  }

  /** Samples not yet handed to the server: still buffered or queued on disk */
  get pending(): number {
    return this.buffer.length + this.queue.size;
  }

  status(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      queuedBatches: this.queue.size,
      droppedBatches: this.queue.dropped,
      software: SOFTWARE,
      interfaces: this.readers.map((slot) => ({ interfaceId: slot.iface.interfaceId, connected: slot.reader !== undefined && !slot.error, lastError: slot.error ?? null })),
    };
  }
}
