/**
 * 서버 글의 언어 — 화면이 고른 언어(Accept-Language · ?lang=)로 오류 · 지적 문구가 나오는가.
 *
 * 🔴 기본은 한국어다. 언어를 싣지 않은 호출자(예전 화면 · 명령줄 · 다른 시스템)가 갑자기 영어를 받으면 안 된다.
 * 🔴 브라우저 기본값(ko-KR,ko;q=0.9,en-US;…)은 첫 값만 본다 — 영어가 목록에 있다고 영어로 가지 않는다.
 */
import { InMemoryStore } from '@aas/store';
import { createApi, createHttpServer, type ApiRequest } from '@aas/api';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const handle = createApi(new InMemoryStore()) as (r: ApiRequest) => Promise<{ status: number; body?: any }>;

const get = (path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
  handle({ method: 'GET', path, query, headers });

describe('서버 글의 언어', () => {
  it('언어를 싣지 않으면 한국어다', async () => {
    const response = await get('/없는-경로');
    expect(response.status).toBe(404);
    expect(response.body.messages[0].text).toBe('경로가 없습니다: GET /없는-경로');
  });

  it('Accept-Language: en 이면 영어다', async () => {
    const response = await get('/nowhere', { 'accept-language': 'en' });
    expect(response.body.messages[0].text).toBe('No such route: GET /nowhere');
  });

  it('?lang=en 이 헤더보다 먼저다 — 새 창 내려받기 주소용', async () => {
    const response = await get('/nowhere', { 'accept-language': 'ko' }, { lang: 'en' });
    expect(response.body.messages[0].text).toBe('No such route: GET /nowhere');
  });

  it('브라우저 기본 목록은 첫 값만 본다', async () => {
    const response = await get('/nowhere', { 'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' });
    expect(response.body.messages[0].text).toBe('경로가 없습니다: GET /nowhere');
  });

  it('동시에 들어온 두 요청의 언어가 섞이지 않는다', async () => {
    const [ko, en] = await Promise.all([get('/a', { 'accept-language': 'ko' }), get('/b', { 'accept-language': 'en' })]);
    expect(ko.body.messages[0].text).toBe('경로가 없습니다: GET /a');
    expect(en.body.messages[0].text).toBe('No such route: GET /b');
  });

  it('로그인 실패 문구', async () => {
    const login = (headers: Record<string, string>) =>
      handle({ method: 'POST', path: '/auth/login', query: {}, headers, body: { login: 'nobody', password: '틀린비밀번호입니다' } });
    const ko = await login({});
    const en = await login({ 'accept-language': 'en' });
    expect(ko.status).toBe(401);
    expect(ko.body.messages[0].text).toBe('로그인하지 못했습니다 — 이름이나 비밀번호를 확인하십시오.');
    expect(en.body.messages[0].text).toBe('Sign-in failed — check the name or password.');
  });

  it('읽기 전용 토큰으로 고치면 403 — 인증 거절도 그 요청의 언어다', async () => {
    const guarded = createApi(new InMemoryStore(), { auth: { tokens: ['full'], readOnlyTokens: ['ro'] } }) as typeof handle;
    const write = (headers: Record<string, string>) =>
      guarded({ method: 'POST', path: '/packages', query: { name: 'x.aasx' }, headers: { authorization: 'Bearer ro', ...headers }, body: new Uint8Array() });
    const ko = await write({});
    const en = await write({ 'accept-language': 'en' });
    expect(ko.status).toBe(403);
    expect(ko.body.messages[0].text).toBe('읽기 전용 토큰으로는 고칠 수 없습니다.');
    expect(en.body.messages[0].text).toBe('A read-only token cannot make changes.');
  });

  it('없는 패키지는 NotFound — 라우트 깊은 곳에서 만든 오류도 옮겨진다', async () => {
    const ko = await get('/packages/없는-패키지/derivation');
    const en = await get('/packages/no-such-package/derivation', { 'accept-language': 'en' });
    expect(ko.status).toBe(404);
    expect(ko.body.messages[0]).toMatchObject({ code: 'NotFound', text: '패키지를 찾을 수 없습니다.' });
    expect(en.body.messages[0]).toMatchObject({ code: 'NotFound', text: 'Package not found.' });
  });

  it('본문 상한(413)은 createApi에 닿기 전에 나가도 그 요청의 언어다 — 실제 서버로', async () => {
    const server = createHttpServer({ store: new InMemoryStore(), maxBodyBytes: 10 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const send = async (headers: Record<string, string>, query = '') => {
      const response = await fetch(`http://127.0.0.1:${port}/packages?name=big.aasx${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...headers },
        body: new Uint8Array(64),
      });
      return { status: response.status, text: ((await response.json()) as any).messages[0].text as string };
    };
    try {
      const ko = await send({});
      const en = await send({ 'accept-language': 'en' });
      const enQuery = await send({ 'accept-language': 'ko' }, '&lang=en');
      expect(ko).toEqual({ status: 413, text: '본문이 상한(10 바이트)을 넘었습니다.' });
      expect(en).toEqual({ status: 413, text: 'The body exceeds the limit (10 bytes).' });
      expect(enQuery.text).toBe('The body exceeds the limit (10 bytes).');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
