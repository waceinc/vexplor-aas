/**
 * The local queue (docs/edge-contract.md §6): every batch is on disk before it is sent and deleted only after a 2xx.
 *
 * Important: written to a temporary name and renamed — a power cut leaves either the whole batch or none, never half a
 *    file that would be refused as BadRequest and lost.
 * Important: bounded. Past `max` batches the oldest are dropped and counted (`droppedBatches` in the next status) —
 *    never silently. A refused batch (400/413/422) moves to refused/ for a person to look at; it is not resent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Batch {
  schema: 'vexplor.edge.batch/1';
  bootId: string;
  seq: number;
  readListRevision: string;
  createdAt: string;
  samples: { tagId: string; observedAt: string; receivedAt: string; value: number | string | boolean | null; quality?: string; error?: string }[];
  status?: Record<string, unknown>;
}

export class DiskQueue {
  private readonly queueDir: string;
  private readonly refusedDir: string;
  dropped = 0;

  constructor(stateDir: string, private readonly max: number) {
    this.queueDir = join(stateDir, 'queue');
    this.refusedDir = join(stateDir, 'refused');
    mkdirSync(this.queueDir, { recursive: true });
    mkdirSync(this.refusedDir, { recursive: true });
  }

  private nameOf(batch: Pick<Batch, 'bootId' | 'seq' | 'createdAt'>): string {
    // createdAt first so batches of different boots still sort in the order they were made
    return `${batch.createdAt.replace(/[:.]/g, '-')}_${batch.bootId}_${String(batch.seq).padStart(10, '0')}.json`;
  }

  add(batch: Batch): void {
    const name = this.nameOf(batch);
    writeFileSync(join(this.queueDir, `${name}.tmp`), JSON.stringify(batch));
    renameSync(join(this.queueDir, `${name}.tmp`), join(this.queueDir, name));
    const files = this.files();
    for (const old of files.slice(0, Math.max(0, files.length - this.max))) {
      unlinkSync(join(this.queueDir, old));
      this.dropped += 1;
    }
  }

  files(): string[] {
    return readdirSync(this.queueDir).filter((name) => name.endsWith('.json')).sort();
  }

  get size(): number {
    return this.files().length;
  }

  read(name: string): Batch {
    return JSON.parse(readFileSync(join(this.queueDir, name), 'utf8')) as Batch;
  }

  done(name: string): void {
    if (existsSync(join(this.queueDir, name))) unlinkSync(join(this.queueDir, name));
  }

  refuse(name: string): void {
    renameSync(join(this.queueDir, name), join(this.refusedDir, name));
  }
}
