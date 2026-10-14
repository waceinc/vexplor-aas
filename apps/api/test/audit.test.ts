/**
 * Audit log — "who changed it".
 *
 * Important: what this file guards is that **the actor set at one choke point (api.ts) reaches the store**.
 *    It must be recorded even when routes do not pass it as a parameter — that is why AsyncLocalStorage is used.
 *    If this breaks it becomes "mostly recorded", which for an audit log is worse than not recording at all.
 *
 * Important: the opposite side guarded alongside: **do not invent facts.** On a server without login
 *    (installs, development) "who" must stay empty, never some arbitrary name.
 */
import { readAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-롤포밍기-공34.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);
const submodelId = golden.environment.submodels![0]!.id;
const encoded = Buffer.from(submodelId, 'utf8').toString('base64url');

type Reply = { status: number; headers: Record<string, string>; body: any };

/** One request that can carry a token or cookie */
function caller(
  api: (request: ApiRequest) => Promise<Reply>,
  init: { cookie?: string; token?: string } = {},
) {
  return async (method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<Reply> => {
    const headers: Record<string, string> = {};
    if (init.cookie) headers['cookie'] = init.cookie;
    if (init.token) headers['authorization'] = `Bearer ${init.token}`;
    return api({
      method,
      path,
      query: query ?? {},
      headers,
      ...(body === undefined ? {} : { body }),
    } as ApiRequest);
  };
}

function cookieFrom(response: Reply): string {
  return (response.headers?.['set-cookie'] ?? '').split(';')[0] ?? '';
}

/** Loads a package, edits a submodel once, and returns its history */
async function editOnce(
  api: (request: ApiRequest) => Promise<Reply>,
  init: { cookie?: string; token?: string } = {},
): Promise<any[]> {
  const call = caller(api, init);
  const created = await call('POST', '/packages', goldenBytes, { name: GOLDEN });
  expect(created.status).toBe(201);
  const packageId = created.body.packageId;

  const current = await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`);
  expect(current.status).toBe(200);
  const updated = await call('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
    ...current.body,
    idShort: '고친이름',
  });
  expect(updated.status).toBe(204);

  const history = await call('GET', `/packages/${packageId}/history/${encoded}`);
  expect(history.status).toBe(200);
  return history.body.result;
}

async function loggedIn(): Promise<{
  api: (request: ApiRequest) => Promise<Reply>;
  cookie: string;
}> {
  const store = new InMemoryStore();
  await store.init();
  const api = createApi(store) as (request: ApiRequest) => Promise<Reply>;
  const made = await api({
    method: 'POST',
    path: '/auth/setup',
    query: {},
    headers: {},
    body: { login: 'hong', displayName: '홍길동', password: '열자가넘는비밀번호입니다' },
  } as ApiRequest);
  expect(made.status).toBe(201);
  return { api, cookie: cookieFrom(made) };
}

describe('audit log — who', () => {
  it('the logged-in person name is recorded in history — even if routes do not pass it', async () => {
    const { api, cookie } = await loggedIn();
    const history = await editOnce(api, { cookie });
    expect(history).toHaveLength(1);
    expect(history[0].actorName).toBe('홍길동');
  });

  it('changes made via an API key are recorded as "API key" — distinguished from people', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['기계키'], readOnlyTokens: [] } }) as (
      request: ApiRequest,
    ) => Promise<Reply>;
    const history = await editOnce(api, { token: '기계키' });
    expect(history[0].actorName).toBe('API 키');
    // Important: the key value itself is never written anywhere — logs travel around in plain text
    expect(JSON.stringify(history)).not.toContain('기계키');
  });

  it('a server without auth leaves it empty — does not invent facts', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as (request: ApiRequest) => Promise<Reply>;
    const history = await editOnce(api);
    expect(history[0].actorName).toBeUndefined();
  });

  it('changing the display name keeps the name used at the time in past records', async () => {
    const { api, cookie } = await loggedIn();
    const call = caller(api, { cookie });
    const created = await call('POST', '/packages', goldenBytes, { name: GOLDEN });
    const packageId = created.body.packageId;
    const current = await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`);
    await call('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      ...current.body,
      idShort: '첫번째',
    });

    // Change the name and edit again (changing the name ends the session, so log in again)
    const me = await call('GET', '/auth/me');
    const userId = me.body.user.id;
    await call('PATCH', `/auth/users/${userId}`, { displayName: '홍길순' });
    const back = await api({
      method: 'POST',
      path: '/auth/login',
      query: {},
      headers: {},
      body: { login: 'hong', password: '열자가넘는비밀번호입니다' },
    } as ApiRequest);
    const again = caller(api, { cookie: cookieFrom(back) });
    const now = await again('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`);
    await again('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      ...now.body,
      idShort: '두번째',
    });

    const history = await again('GET', `/packages/${packageId}/history/${encoded}`);
    // Newest first — name after the change, then name before. If the past changed retroactively it would not be an audit log
    expect(history.body.result.map((entry: any) => entry.actorName)).toEqual(['홍길순', '홍길동']);
  });

  it('the undo list also shows who made each change', async () => {
    const { api, cookie } = await loggedIn();
    const call = caller(api, { cookie });
    const created = await call('POST', '/packages', goldenBytes, { name: GOLDEN });
    const packageId = created.body.packageId;
    const current = await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`);
    await call('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      ...current.body,
      idShort: '고친이름',
    });

    const status = await call('GET', `/packages/${packageId}/undo`);
    expect(status.status).toBe(200);
    expect(status.body.undo[0]).toContain('홍길동');
  });
});
