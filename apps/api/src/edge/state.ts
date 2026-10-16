/**
 * Edge devices, registration codes and batch idempotency — kept in the store's runtime state (memory, folder and
 * PostgreSQL stores all have it), so the edge works on every store without a schema change.
 *
 * Important: one writer at a time. Every change goes through `exclusive`, a promise chain — two batches of one device
 *    arriving together must not both pass the "already seen?" check. This holds within one server process, which is the
 *    supported deployment (one App Service instance); the store-level unique constraint is plan item 8.
 * Important: registration codes are stored as SHA-256 only. A code is a bearer secret until it is used; the store, its
 *    backups and its logs never hold it in clear.
 * Important: a device never "sees all". It belongs to the workspace of the person who made its code, with
 *    `seesAll: false` even when that person is an admin — a machine in a factory must not read other workspaces.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { IntegrationStore } from '@aas/store';
import type { ReadListInterface } from './read-list.js';

const CODES = 'edge.codes';
const DEVICES = 'edge.devices';
const seenKey = (deviceId: string): string => `edge.seen.${deviceId}`;
/** Batches remembered per device for the idempotency check — enough for days of retries at the default rate */
const SEEN_PER_DEVICE = 20_000;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 — no I, L, O, U

export type EdgeState = 'pending-approval' | 'approved' | 'paused';

export interface ApprovedList {
  revision: string;
  approvedAt: string;
  interfaces: ReadListInterface[];
}

export interface EdgeDevice {
  deviceId: string;
  publicKey: string;
  name: string;
  hostname?: string;
  software: { name: string; version: string };
  /** Workspace key, or null on a server that does not partition */
  workspace: string | null;
  registeredAt: string;
  state: EdgeState;
  approved?: ApprovedList;
  revokedAt?: string;
}

interface CodeRecord {
  workspace: string | null;
  createdAt: string;
  expiresAt: string;
}

type RuntimeState = Pick<IntegrationStore, 'getRuntimeState' | 'putRuntimeState'>;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export class EdgeRegistry {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: RuntimeState,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Runs `fn` after every earlier change has finished */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A new one-time code, returned once in clear */
  createCode(workspace: string | null, ttlHours = 24): Promise<{ code: string; expiresAt: string }> {
    return this.exclusive(async () => {
      const bytes = randomBytes(12);
      const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % 32]).join('');
      const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + ttlHours * 3600_000).toISOString();
      const codes = await this.codes();
      codes[sha256(normaliseCode(code))] = { workspace, createdAt: createdAt.toISOString(), expiresAt };
      await this.store.putRuntimeState(CODES, codes);
      return { code, expiresAt };
    });
  }

  /**
   * Uses a code and creates the device. `undefined` for an unknown, used or expired code — the caller does not learn
   * which. `'key-taken'` when the public key already belongs to a device.
   */
  register(code: string, device: Omit<EdgeDevice, 'deviceId' | 'workspace' | 'registeredAt' | 'state'>): Promise<EdgeDevice | 'key-taken' | undefined> {
    return this.exclusive(async () => {
      const codes = await this.codes();
      const hash = sha256(normaliseCode(code));
      const record = codes[hash];
      const now = this.now();
      if (!record || Date.parse(record.expiresAt) <= now.getTime()) return undefined;
      const devices = await this.devices();
      if (Object.values(devices).some((existing) => existing.publicKey === device.publicKey)) return 'key-taken';
      delete codes[hash];
      for (const [key, value] of Object.entries(codes)) if (Date.parse(value.expiresAt) <= now.getTime()) delete codes[key];
      const created: EdgeDevice = {
        ...device,
        deviceId: `dev_${randomBytes(8).toString('hex')}`,
        workspace: record.workspace,
        registeredAt: now.toISOString(),
        state: 'pending-approval',
      };
      devices[created.deviceId] = created;
      // Device first, then the used code: a crash in between leaves an unused code, never a code that made two devices
      await this.store.putRuntimeState(DEVICES, devices);
      await this.store.putRuntimeState(CODES, codes);
      return created;
    });
  }

  async device(deviceId: string): Promise<EdgeDevice | undefined> {
    return (await this.devices())[deviceId];
  }

  async list(): Promise<EdgeDevice[]> {
    return Object.values(await this.devices()).sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  }

  /** Replaces one device record (approve, pause, revoke) */
  update(deviceId: string, change: (device: EdgeDevice) => EdgeDevice): Promise<EdgeDevice | undefined> {
    return this.exclusive(async () => {
      const devices = await this.devices();
      const current = devices[deviceId];
      if (!current) return undefined;
      devices[deviceId] = change(current);
      await this.store.putRuntimeState(DEVICES, devices);
      return devices[deviceId];
    });
  }

  /**
   * Records (device, bootId, seq) and runs `store` once for it. Returns false — and runs nothing — when the batch was
   * already stored. `store` runs inside the lock, so a duplicate arriving meanwhile waits and then sees it.
   */
  once(deviceId: string, bootId: string, seq: number, store: () => Promise<void>): Promise<boolean> {
    return this.exclusive(async () => {
      const seen = ((await this.store.getRuntimeState(seenKey(deviceId))) as string[] | undefined) ?? [];
      const key = `${bootId}#${seq}`;
      if (seen.includes(key)) return false;
      await store();
      seen.push(key);
      await this.store.putRuntimeState(seenKey(deviceId), seen.slice(-SEEN_PER_DEVICE));
      return true;
    });
  }

  private async codes(): Promise<Record<string, CodeRecord>> {
    return { ...((await this.store.getRuntimeState(CODES)) as Record<string, CodeRecord> | undefined) };
  }

  private async devices(): Promise<Record<string, EdgeDevice>> {
    return { ...((await this.store.getRuntimeState(DEVICES)) as Record<string, EdgeDevice> | undefined) };
  }
}

/** Upper case, no spaces or dashes — a code read aloud or typed with dashes still matches */
function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}
