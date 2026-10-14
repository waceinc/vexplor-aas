/**
 * OPC UA start-up honesty (live E2E D4): the log says "on" only when the server really runs, and
 * GET /integrations/status reports `opcua: { security, running, pki }` (design §4.2).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '@aas/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/password.js';
import { createHttpServer, integrationsOf } from '../src/server.js';

const KEYS = ['OPCUA_SERVER', 'OPCUA_PORT', 'OPCUA_PKI_DIR', 'OPCUA_ALLOW_INSECURE'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function boot(port: number, withAccount: boolean) {
  const pki = mkdtempSync(join(tmpdir(), 'aas-opcua-start-'));
  cleanups.push(() => rmSync(pki, { recursive: true, force: true }));
  Object.assign(process.env, { OPCUA_SERVER: 'on', OPCUA_PORT: String(port), OPCUA_PKI_DIR: pki, OPCUA_ALLOW_INSECURE: '' });
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
  const store = new InMemoryStore();
  await store.init();
  if (withAccount) await store.createUser({ login: 'admin', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword('열자가넘는비밀번호입니다') });
  const app = createHttpServer({ store });
  cleanups.push(() => new Promise<void>((resolve) => app.close(() => resolve())));
  return { app, pki, logs, errors, opcua: () => integrationsOf(app)!.services.opcua() };
}

describe('OPC UA start-up (D4)', () => {
  it('secure mode without accounts: refused, never logged as on, status running:false with the store path', async () => {
    const { logs, errors, pki, opcua } = await boot(14897, false);
    await until(() => errors.some((line) => line.includes('OPCUA_ALLOW_INSECURE=on')));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs.filter((line) => line.includes('opc.tcp://'))).toEqual([]);
    expect(opcua()).toEqual({ security: 'secure', running: false, pki });
  });

  it('secure mode with an account: starts, logs the endpoint and secure mode, status running:true', async () => {
    const { logs, errors, pki, opcua } = await boot(14898, true);
    await until(() => opcua().running);
    await until(() => logs.some((line) => line.includes(pki)));
    expect(logs.some((line) => line.includes('opc.tcp://') && line.includes('14898'))).toBe(true);
    expect(errors).toEqual([]);
    expect(opcua()).toEqual({ security: 'secure', running: true, pki: expect.stringContaining(pki) });
  }, 60_000);
});
