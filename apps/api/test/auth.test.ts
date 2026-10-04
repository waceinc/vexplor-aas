/**
 * 접근 제어 검증.
 *
 * 여기서 확인하는 것은 넷이다.
 *  ① 토큰이 없으면 열려 있다(개발·시연) — 다만 그 사실이 드러난다
 *  ② 토큰을 설정하면 전부 막힌다
 *  ③ 읽기 전용 토큰은 읽기만 된다
 *  ④ /health는 언제나 열려 있다 — 살아 있는지 보는 데 토큰이 필요하면 곤란하다
 */
import {
  authFromEnv,
  createApi,
  isAsciiToken,
  isOpen,
  OPEN_ACCESS,
  resolveBindHost,
  tokenOf,
  type ApiRequest,
} from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

async function api(auth?: { tokens: string[]; readOnlyTokens: string[] }) {
  const store = new InMemoryStore();
  await store.init();
  const handle = createApi(store, auth ? { auth } : {});
  return async (
    method: string,
    path: string,
    init: { token?: string; body?: unknown; query?: Record<string, string> } = {},
  ) => {
    const response = await handle({
      method,
      path,
      query: init.query ?? {},
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      ...(init.body === undefined ? {} : { body: init.body }),
    } as ApiRequest);
    return { status: response.status, body: response.body as any };
  };
}

describe('인증이 꺼져 있을 때', () => {
  it('토큰 없이 다 된다 — 개발과 시연을 깨뜨리지 않는다', async () => {
    const call = await api();
    expect((await call('GET', '/packages')).status).toBe(200);
    expect(
      (await call('POST', '/packages', { body: goldenBytes, query: { name: 'x.aasx' } })).status,
    ).toBe(201);
  });

  it('🔴 꺼져 있다는 사실을 /health가 드러낸다 — 조용히 열려 있으면 안 된다', async () => {
    const call = await api();
    expect((await call('GET', '/health')).body).toMatchObject({ status: 'ok', auth: 'off' });
  });
});

describe('인증이 켜져 있을 때', () => {
  const auth = { tokens: ['secret-full'], readOnlyTokens: ['secret-read'] };

  it('토큰이 없으면 401', async () => {
    const call = await api(auth);
    const denied = await call('GET', '/packages');
    expect(denied.status).toBe(401);
    expect(denied.body.messages[0].code).toBe('Unauthorized');
  });

  it('틀린 토큰도 401 — 있는지 없는지 알려 주지 않는다', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: '아무거나' })).status).toBe(401);
    // 길이가 달라도 같은 응답이다
    expect((await call('GET', '/packages', { token: 'x' })).status).toBe(401);
  });

  it('전체 토큰이면 읽기·쓰기 다 된다', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: 'secret-full' })).status).toBe(200);
    const created = await call('POST', '/packages', {
      token: 'secret-full',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    expect(created.status).toBe(201);
  });

  it('읽기 전용 토큰은 읽기만 된다 — 검수자에게 편집 권한을 줄 이유가 없다', async () => {
    const call = await api(auth);
    expect((await call('GET', '/packages', { token: 'secret-read' })).status).toBe(200);

    const blocked = await call('POST', '/packages', {
      token: 'secret-read',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.messages[0].text).toContain('읽기 전용');
  });

  it('편집 경로도 함께 막힌다 — 목록만 막고 끝나면 소용없다', async () => {
    const call = await api(auth);
    const created = await call('POST', '/packages', {
      token: 'secret-full',
      body: goldenBytes,
      query: { name: 'x.aasx' },
    });
    const id = created.body.packageId;

    // 읽기 전용 토큰으로 지우기·고치기 시도
    expect((await call('DELETE', `/packages/${id}`, { token: 'secret-read' })).status).toBe(403);
    expect((await call('POST', `/packages/${id}/fix`, { token: 'secret-read' })).status).toBe(403);
    // 토큰 없이 Part 2 경로
    expect((await call('GET', `/packages/${id}/api/v3.0/submodels`)).status).toBe(401);
  });

  it('/health는 언제나 열려 있다', async () => {
    const call = await api(auth);
    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.auth).toBe('on');
  });
});

describe('설정 읽기', () => {
  it('환경변수에서 쉼표로 여러 개를 받는다', () => {
    const config = authFromEnv({ AAS_TOKEN: ' a , b ', AAS_READONLY_TOKEN: 'c' });
    expect(config.tokens).toEqual(['a', 'b']);
    expect(config.readOnlyTokens).toEqual(['c']);
    expect(isOpen(config)).toBe(false);
  });

  it('비어 있으면 열린 상태', () => {
    expect(isOpen(authFromEnv({}))).toBe(true);
    expect(isOpen(authFromEnv({ AAS_TOKEN: '  ,  ' }))).toBe(true);
  });

  it('🔴 한글 토큰도 통한다 — Node는 헤더를 latin1로 읽는다', () => {
    // 실제로 회선을 타면 이렇게 들어온다: UTF-8 바이트를 latin1로 읽은 문자열
    const onTheWire = Buffer.from('편집용', 'utf8').toString('latin1');
    expect(onTheWire).not.toBe('편집용'); // 그냥 두면 설정값과 다른 문자열이다

    const request = { headers: { authorization: `Bearer ${onTheWire}` } } as ApiRequest;
    expect(tokenOf(request)).toBe('편집용');
  });

  it('ASCII 밖 토큰을 가려낸다 — 기동할 때 경고한다', () => {
    expect(isAsciiToken('factory-2026-abc')).toBe(true);
    expect(isAsciiToken('편집용')).toBe(false);
  });

  it('토큰은 헤더에서만 읽는다 — 질의 인자는 로그에 남는다', () => {
    expect(tokenOf({ headers: { authorization: 'Bearer abc' } } as ApiRequest)).toBe('abc');
    expect(tokenOf({ headers: { authorization: 'bearer  abc  ' } } as ApiRequest)).toBe('abc');
    expect(tokenOf({ headers: {} } as ApiRequest)).toBeUndefined();
  });
});

/**
 * 보호 모드 — 공개 저장소에서 받아 그대로 띄우는 사람을 위한 안전장치.
 * 시작 로그 경고만으로는 안 읽는 사람에게 닿지 않는다. 아예 밖으로 열지 않는다.
 */
describe('보호 모드 — 토큰이 없으면 밖으로 열지 않는다', () => {
  it('토큰이 없으면 이 컴퓨터에서만 연다', () => {
    expect(resolveBindHost({}, OPEN_ACCESS)).toEqual({ host: '127.0.0.1', protected: true });
  });

  it('토큰이 있으면 밖으로 연다', () => {
    expect(resolveBindHost({}, { tokens: ['abc'], readOnlyTokens: [] })).toEqual({
      host: '0.0.0.0',
      protected: false,
    });
  });

  it('읽기 전용 토큰만 있어도 밖으로 연다 — 검수자에게 보여 주는 용도다', () => {
    expect(resolveBindHost({}, { tokens: [], readOnlyTokens: ['ro'] }).host).toBe('0.0.0.0');
  });

  it('AAS_ALLOW_OPEN=1이면 토큰 없이도 밖으로 연다 — 스스로 정한 경우만 넘어간다', () => {
    expect(resolveBindHost({ AAS_ALLOW_OPEN: '1' }, OPEN_ACCESS).host).toBe('0.0.0.0');
  });

  it('AAS_HOST를 직접 주면 그것을 쓴다', () => {
    expect(resolveBindHost({ AAS_HOST: '10.0.0.5' }, OPEN_ACCESS).host).toBe('10.0.0.5');
  });
});
