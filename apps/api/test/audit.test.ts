/**
 * 감사 기록 — 「누가 바꿨나」.
 *
 * 🔴 이 파일이 지키는 것은 **길목 한 곳(api.ts)에서 깐 행위자가 저장소까지 간다**는 사실이다.
 *    라우트가 매개변수로 넘기지 않아도 남아야 한다 — 그러라고 AsyncLocalStorage를 쓴다.
 *    여기가 깨지면 "대부분 남는다"가 되는데, 감사 기록에서 그것은 안 남는 것만 못하다.
 *
 * 🔴 함께 지키는 반대쪽: **없는 사실을 지어내지 않는다.** 로그인을 쓰지 않는 서버
 *    (설치판·개발)에서는 「누가」가 비어 있어야지, 아무 이름이나 들어가면 안 된다.
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

/** 토큰·쿠키를 들려 보낼 수 있는 요청 한 건 */
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

/** 패키지를 담고, 서브모델을 한 번 고치고, 그 이력을 돌려준다 */
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

describe('감사 기록 — 누가', () => {
  it('로그인한 사람의 이름이 이력에 남는다 — 라우트가 넘기지 않아도', async () => {
    const { api, cookie } = await loggedIn();
    const history = await editOnce(api, { cookie });
    expect(history).toHaveLength(1);
    expect(history[0].actorName).toBe('홍길동');
  });

  it('API 키로 들어온 변경은 「API 키」로 남는다 — 사람과 구분된다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store, { auth: { tokens: ['기계키'], readOnlyTokens: [] } }) as (
      request: ApiRequest,
    ) => Promise<Reply>;
    const history = await editOnce(api, { token: '기계키' });
    expect(history[0].actorName).toBe('API 키');
    // 🔴 키 값 자체는 어디에도 적지 않는다 — 기록은 평문으로 돌아다닌다
    expect(JSON.stringify(history)).not.toContain('기계키');
  });

  it('인증을 쓰지 않는 서버는 비워 둔다 — 없는 사실을 지어내지 않는다', async () => {
    const store = new InMemoryStore();
    await store.init();
    const api = createApi(store) as (request: ApiRequest) => Promise<Reply>;
    const history = await editOnce(api);
    expect(history[0].actorName).toBeUndefined();
  });

  it('표시 이름을 바꿔도 지난 기록은 그때 그 이름이다', async () => {
    const { api, cookie } = await loggedIn();
    const call = caller(api, { cookie });
    const created = await call('POST', '/packages', goldenBytes, { name: GOLDEN });
    const packageId = created.body.packageId;
    const current = await call('GET', `/packages/${packageId}/api/v3.0/submodels/${encoded}`);
    await call('PUT', `/packages/${packageId}/api/v3.0/submodels/${encoded}`, {
      ...current.body,
      idShort: '첫번째',
    });

    // 이름을 바꾸고 다시 고친다 (이름이 바뀌면 세션이 끊기므로 다시 로그인한다)
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
    // 최신이 앞 — 바꾼 뒤 이름 · 바꾸기 전 이름. 과거가 소급해 바뀌면 감사 기록이 아니다
    expect(history.body.result.map((entry: any) => entry.actorName)).toEqual(['홍길순', '홍길동']);
  });

  it('되돌리기 목록에도 누가 한 변경인지 붙는다', async () => {
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
