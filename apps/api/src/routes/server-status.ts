/**
 * The server's own state for an admin (2.8.0): is the store answering, how much disk is left, what the remote
 * collectors sent in the last hour, which version runs.
 *
 *     GET /server/status   → admin session only
 *
 * Important: admins only. /health stays public and small (the Docker healthcheck and the sign-in screen read it); free
 *    disk space and traffic say more about a deployment than a stranger should learn.
 * Important: the disk is the one this server writes to — the data folder of a folder store, otherwise the folder the
 *    server runs in. A PostgreSQL database may sit on another machine; its disk is not visible from here and the answer
 *    says so instead of guessing.
 * Important: the store check is one cheap read with a time limit. A store that hangs must not hang this page too.
 */
import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PRODUCT_VERSION, tr } from '@aas/core';
import type { AasStore } from '@aas/store';
import { json } from '../http.js';
import { requireAdminSession } from '../integration/route-support.js';
import type { Route } from '../router.js';
import type { EdgeTraffic } from '../edge/traffic.js';

export type ServerStoreKind = 'memory' | 'folder' | 'postgres';

export interface ServerStatusOptions {
  store: AasStore;
  storeKind: ServerStoreKind;
  /** Data folder of a folder store */
  dataDir?: string;
  /** Present when the remote collector endpoints are on */
  traffic?: EdgeTraffic;
  startedAt?: Date;
  now?: () => Date;
  /** Tests only — the store check waits this long at most */
  storeTimeoutMs?: number;
}

const STORE_TIMEOUT_MS = 5_000;

export function serverStatusRoutes(options: ServerStatusOptions): Route[] {
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now();
  return [
    {
      method: 'GET',
      pattern: '/server/status',
      async handle({ request }) {
        requireAdminSession(request);
        const at = now();
        return json(200, {
          version: PRODUCT_VERSION,
          startedAt: startedAt.toISOString(),
          uptimeSeconds: Math.max(0, Math.round((at.getTime() - startedAt.getTime()) / 1000)),
          store: { kind: options.storeKind, ...(await checkStore(options.store, options.storeTimeoutMs ?? STORE_TIMEOUT_MS)) },
          disk: diskOf(options.storeKind === 'folder' && options.dataDir ? options.dataDir : process.cwd(), options.storeKind === 'folder' && options.dataDir ? 'data' : 'server'),
          edge: options.traffic ? { ...options.traffic.lastHour(), sinceStart: at.getTime() - startedAt.getTime() < 3_600_000 } : null,
        });
      },
    },
  ];
}

async function checkStore(store: AasStore, timeoutMs: number): Promise<{ ok: boolean; responseMs: number; error?: string }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      store.countUsers(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(tr('저장소가 제때 답하지 않았습니다.'))), timeoutMs);
      }),
    ]);
    return { ok: true, responseMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, responseMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function diskOf(path: string, of: 'data' | 'server'): { of: 'data' | 'server'; path: string; freeBytes: number; totalBytes: number; freePercent: number } | null {
  try {
    const stats = statfsSync(path);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { of, path: resolve(path), freeBytes: free, totalBytes: total, freePercent: total > 0 ? Math.round((free / total) * 1000) / 10 : 0 };
  } catch {
    return null;
  }
}
