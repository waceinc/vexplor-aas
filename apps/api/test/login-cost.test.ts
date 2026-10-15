/**
 * What a login costs, and when it is counted (red-team M1 and L4, 2026-10-16).
 *
 *   M1 — an unknown or disabled login must still run a full password check, or the response time says which
 *        logins exist (scrypt takes tens of milliseconds; a missing account answered in about one).
 *   L4 — the attempt is counted **before** the expensive hash. Counting after let a burst of parallel guesses all get
 *        past the per-address cap while their hashes were still running, and made the server do all that work.
 *
 * Important: timing is not measured here — that is flaky on a busy CI machine. The password check is wrapped instead,
 *    so the test sees deterministically whether it ran and lets it be held open.
 */
import { InMemoryStore } from '@aas/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';
import * as password from '../src/password.js';

const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, calls: 0 }));

vi.mock('../src/password.js', async (original) => {
  const real = await original<typeof import('../src/password.js')>();
  return {
    ...real,
    verifyPassword: async (plain: string, stored: string): Promise<boolean> => {
      gate.calls += 1;
      if (gate.hold) await gate.hold;
      return real.verifyPassword(plain, stored);
    },
  };
});

type Reply = { status: number; headers: Record<string, string>; body: any };
const PASSWORD = 'correct-horse-battery';

function login(name: string, secret: string, from: string): ApiRequest {
  return {
    method: 'POST',
    path: '/auth/login',
    query: {},
    headers: { 'x-forwarded-for': from },
    body: { login: name, password: secret },
  } as ApiRequest;
}

async function server(): Promise<(r: ApiRequest) => Promise<Reply>> {
  const store = new InMemoryStore();
  await store.init();
  await store.createUser({ login: 'alice', displayName: 'A', role: 'admin', passwordHash: await password.hashPassword(PASSWORD) });
  const locked = await store.createUser({ login: 'carol', displayName: 'C', role: 'editor', passwordHash: await password.hashPassword(PASSWORD) });
  await store.updateUser(locked.id, { disabled: true });
  return createApi(store) as (r: ApiRequest) => Promise<Reply>;
}

beforeEach(() => {
  gate.hold = undefined;
  gate.calls = 0;
});

describe('M1 — every login runs the password check, whether or not the account exists', () => {
  it('an unknown login is checked against a decoy hash', async () => {
    const api = await server();
    const reply = await api(login('ghostuser', 'wrong-but-long-xx', '203.0.113.1'));
    expect(reply.status).toBe(401);
    expect(gate.calls).toBe(1);
  });

  it('a disabled account is checked too, and the answer is the same 401', async () => {
    const api = await server();
    const reply = await api(login('carol', PASSWORD, '203.0.113.2'));
    expect(reply.status).toBe(401);
    expect(gate.calls).toBe(1);
  });
});

describe('L4 — the attempt is counted before the hash runs', () => {
  it('a parallel burst from one address is cut at the per-address cap while the first hashes are still running', async () => {
    const api = await server();
    let release!: () => void;
    gate.hold = new Promise<void>((resolve) => (release = resolve));

    const burst = Array.from({ length: 5 }, () => api(login('alice', 'wrong-but-long-xx', '198.51.100.9')));
    // Let the five reach the (held) password check
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sixth = api(login('alice', 'wrong-but-long-xx', '198.51.100.9'));
    const early = await Promise.race([sixth, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200))]);

    release();
    await Promise.all(burst);
    expect(early).not.toBe('pending');
    expect((early as Reply).status).toBe(429);
  });

  it('a successful login does not count against the account', async () => {
    const api = await server();
    for (let i = 0; i < 3; i += 1) {
      expect((await api(login('alice', PASSWORD, '198.51.100.10'))).status).toBe(200);
    }
    // Two wrong guesses after three good logins — still below the cap of five
    for (let i = 0; i < 2; i += 1) await api(login('alice', 'wrong-but-long-xx', '198.51.100.10'));
    expect((await api(login('alice', PASSWORD, '198.51.100.10'))).status).toBe(200);
  });
});
