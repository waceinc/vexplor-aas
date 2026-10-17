/**
 * Edge devices, registration codes and batch idempotency — kept in the store's runtime state (memory, folder and
 * PostgreSQL stores all have it), so the edge works on every store without a schema change.
 *
 * Important: one server process writes this state — the supported deployment (one App Service instance). So devices and
 *    codes are read once and kept in memory: an unsigned request with a made-up device id costs no store read (review
 *    M5), and every change is written through.
 * Important: two locks. Codes and devices change under one registry lock; batches take a lock **per device**, so one
 *    device's traffic never queues another's (review H2/H3). Within a device, two copies of one batch are serialised,
 *    so the second sees the first.
 * Important: the idempotency memory is bounded. Per boot it keeps `floor` (every seq up to it was stored) and the few seqs
 *    above it, for the last few boots — a device cannot grow it by sending long or many boot ids (review H2).
 * Important: registration codes are stored as SHA-256 only. A code is a bearer secret until it is used.
 * Important: activity (last batch, values stored, the status a batch carries) lives in memory and is written at most once
 *    a minute — it is for the screen, not a record. A restart may lose the last minute of it; values are never lost.
 * Important: a code made with a pre-approved list hands the device exactly the list the person saw at that moment, even
 *    if the files change before the device registers — the screen then shows "changed since approval".
 * Important: a device never "sees all". It belongs to the workspace of the person who made its code, with
 *    `seesAll: false` even when that person is an admin — a machine in a factory must not read other workspaces.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { IntegrationStore } from '@aas/store';
import type { ReadListInterface } from './read-list.js';

const CODES = 'edge.codes';
const DEVICES = 'edge.devices';
const ENABLED = 'edge.enabled';
const ACTIVITY = 'edge.activity';
/** Activity is kept in memory and written at most this often — a batch every 5 s must not rewrite the store each time */
const ACTIVITY_WRITE_MS = 60_000;
const seenKey = (deviceId: string): string => `edge.seen.${deviceId}`;
/** Boots remembered per device, and out-of-order seqs remembered per boot */
const BOOTS_KEPT = 8;
const ABOVE_FLOOR_KEPT = 4096;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 — no I, L, O, U

export type EdgeState = 'pending-approval' | 'approved' | 'paused';

export interface ApprovedList {
  /** What the edge sees — the approved interfaces with their intervals */
  revision: string;
  /** The preview revision the person approved — the files as they were; "changed since approval" compares this */
  basis?: string;
  approvedAt: string;
  interfaces: ReadListInterface[];
}

export interface EdgeDevice {
  deviceId: string;
  publicKey: string;
  name: string;
  hostname?: string;
  software: { name: string; version: string };
  /** Workspace key, or null when registered on a server that does not partition */
  workspace: string | null;
  registeredAt: string;
  state: EdgeState;
  approved?: ApprovedList;
  /** 'code' — approved by the person who made its registration code (one-click); 'person' — approved afterwards */
  approvedVia?: 'code' | 'person';
  revokedAt?: string;
}

/** What the device last told the server (batch `status`), and when */
export interface EdgeActivity {
  lastSeenAt: string;
  samplesReceived: number;
  lastStatus: Record<string, unknown> | null;
}

interface CodeRecord {
  workspace: string | null;
  createdAt: string;
  expiresAt: string;
  /** The list the person saw and approved when making the code — the device gets exactly this on registering */
  preapproved?: ApprovedList;
}

interface BootWindow {
  bootId: string;
  /** Every seq from 1 to floor has been stored */
  floor: number;
  /** Stored seqs above floor (out of order), ascending */
  above: number[];
}

type RuntimeState = Pick<IntegrationStore, 'getRuntimeState' | 'putRuntimeState'>;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

class Lock {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export class EdgeRegistry {
  private readonly lock = new Lock();
  private readonly deviceLocks = new Map<string, Lock>();
  private loaded: Promise<{ codes: Map<string, CodeRecord>; devices: Map<string, EdgeDevice> }> | undefined;
  private activityLoaded: Promise<Map<string, EdgeActivity>> | undefined;
  private activityWrittenAt = 0;

  constructor(
    private readonly store: RuntimeState,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load() {
    this.loaded ??= (async () => {
      const codes = (await this.store.getRuntimeState(CODES)) as Record<string, CodeRecord> | undefined;
      const devices = (await this.store.getRuntimeState(DEVICES)) as Record<string, EdgeDevice> | undefined;
      return { codes: new Map(Object.entries(codes ?? {})), devices: new Map(Object.entries(devices ?? {})) };
    })();
    return this.loaded;
  }

  private async saveCodes(codes: Map<string, CodeRecord>): Promise<void> {
    await this.store.putRuntimeState(CODES, Object.fromEntries(codes));
  }

  private async saveDevices(devices: Map<string, EdgeDevice>): Promise<void> {
    await this.store.putRuntimeState(DEVICES, Object.fromEntries(devices));
  }

  /** Whether the edge is switched on from the screen (used only when EDGE is not set) */
  async enabled(): Promise<boolean> {
    return (await this.store.getRuntimeState(ENABLED)) === true;
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.lock.run(() => this.store.putRuntimeState(ENABLED, enabled));
  }

  private activities() {
    this.activityLoaded ??= (async () => {
      const saved = (await this.store.getRuntimeState(ACTIVITY)) as Record<string, EdgeActivity> | undefined;
      return new Map(Object.entries(saved ?? {}));
    })();
    return this.activityLoaded;
  }

  async activity(deviceId: string): Promise<EdgeActivity | undefined> {
    return (await this.activities()).get(deviceId);
  }

  /** A batch arrived: when, how many values were stored, and the status it carried */
  async recordActivity(deviceId: string, stored: number, status: Record<string, unknown> | undefined): Promise<void> {
    const all = await this.activities();
    const before = all.get(deviceId);
    const now = this.now();
    all.set(deviceId, {
      lastSeenAt: now.toISOString(),
      samplesReceived: (before?.samplesReceived ?? 0) + stored,
      lastStatus: status ?? before?.lastStatus ?? null,
    });
    if (now.getTime() - this.activityWrittenAt >= ACTIVITY_WRITE_MS) {
      this.activityWrittenAt = now.getTime();
      await this.store.putRuntimeState(ACTIVITY, Object.fromEntries(all));
    }
  }

  /** A new one-time code, returned once in clear. With `preapproved`, the device it registers reads that list at once */
  createCode(workspace: string | null, ttlHours = 24, preapproved?: ApprovedList): Promise<{ code: string; expiresAt: string }> {
    return this.lock.run(async () => {
      const { codes } = await this.load();
      const chars = [...randomBytes(12)].map((byte) => CODE_ALPHABET[byte % 32]).join('');
      const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + ttlHours * 3600_000).toISOString();
      codes.set(sha256(normaliseCode(code)), { workspace, createdAt: createdAt.toISOString(), expiresAt, ...(preapproved ? { preapproved } : {}) });
      await this.saveCodes(codes);
      return { code, expiresAt };
    });
  }

  /** Whether the code could register — checked before the lock, so junk codes never queue behind real work */
  async codeLooksValid(code: string): Promise<boolean> {
    const record = (await this.load()).codes.get(sha256(normaliseCode(code)));
    return record !== undefined && Date.parse(record.expiresAt) > this.now().getTime();
  }

  /**
   * Uses a code and creates the device. `undefined` for an unknown, used or expired code — the caller does not learn
   * which. `'key-taken'` when the public key already belongs to a device.
   */
  register(code: string, device: Omit<EdgeDevice, 'deviceId' | 'workspace' | 'registeredAt' | 'state'>): Promise<EdgeDevice | 'key-taken' | undefined> {
    return this.lock.run(async () => {
      const { codes, devices } = await this.load();
      const hash = sha256(normaliseCode(code));
      const record = codes.get(hash);
      const now = this.now();
      if (!record || Date.parse(record.expiresAt) <= now.getTime()) return undefined;
      if ([...devices.values()].some((existing) => existing.publicKey === device.publicKey)) return 'key-taken';
      const created: EdgeDevice = {
        ...device,
        deviceId: `dev_${randomBytes(8).toString('hex')}`,
        workspace: record.workspace,
        registeredAt: now.toISOString(),
        ...(record.preapproved
          ? { state: 'approved' as const, approved: { ...record.preapproved, approvedAt: now.toISOString() }, approvedVia: 'code' as const }
          : { state: 'pending-approval' as const }),
      };
      devices.set(created.deviceId, created);
      codes.delete(hash);
      for (const [key, value] of codes) if (Date.parse(value.expiresAt) <= now.getTime()) codes.delete(key);
      // Device first, then the used code: a crash in between leaves an unused code, never a code that made two devices
      await this.saveDevices(devices);
      await this.saveCodes(codes);
      return created;
    });
  }

  async device(deviceId: string): Promise<EdgeDevice | undefined> {
    return (await this.load()).devices.get(deviceId);
  }

  async list(): Promise<EdgeDevice[]> {
    return [...(await this.load()).devices.values()].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  }

  /** Replaces one device record (approve, pause, revoke) */
  update(deviceId: string, change: (device: EdgeDevice) => EdgeDevice): Promise<EdgeDevice | undefined> {
    return this.lock.run(async () => {
      const { devices } = await this.load();
      const current = devices.get(deviceId);
      if (!current) return undefined;
      const next = change(current);
      devices.set(deviceId, next);
      await this.saveDevices(devices);
      return next;
    });
  }

  /**
   * Runs `store` once for (device, bootId, seq). Returns false — and runs nothing — when the batch was already stored.
   * `store` runs inside the device's lock, so a duplicate arriving meanwhile waits and then sees it. When `store` throws,
   * nothing is recorded and a retry runs it again — so `store` must write all or nothing (routes-edge.ts checks every
   * package before writing).
   */
  once(deviceId: string, bootId: string, seq: number, store: () => Promise<void>): Promise<boolean> {
    let lock = this.deviceLocks.get(deviceId);
    if (!lock) this.deviceLocks.set(deviceId, (lock = new Lock()));
    return lock.run(async () => {
      const boots = ((await this.store.getRuntimeState(seenKey(deviceId))) as BootWindow[] | undefined) ?? [];
      let window = boots.find((boot) => boot.bootId === bootId);
      if (window && (seq <= window.floor || window.above.includes(seq))) return false;
      await store();
      // The boot just used goes last, so `slice(-BOOTS_KEPT)` drops the boots unused the longest
      if (window) boots.splice(boots.indexOf(window), 1);
      else window = { bootId, floor: 0, above: [] };
      boots.push(window);
      window.above = [...window.above, seq].sort((a, b) => a - b);
      while (window.above[0] === window.floor + 1) {
        window.floor += 1;
        window.above.shift();
      }
      // A gap that never fills would grow `above` forever — past the cap the oldest out-of-order seqs move into floor
      while (window.above.length > ABOVE_FLOOR_KEPT) window.floor = window.above.shift()!;
      await this.store.putRuntimeState(seenKey(deviceId), boots.slice(-BOOTS_KEPT));
      return true;
    });
  }
}

/** Upper case, no spaces or dashes — a code read aloud or typed with dashes still matches */
function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}
