/**
 * Server text language — do error and finding messages come out in the language the UI chose (Accept-Language, ?lang=)?
 *
 * Important: the default is Korean. Callers that send no language (older UI, command line, other systems) must not suddenly get English.
 * Important: for the browser default (ko-KR,ko;q=0.9,en-US;…) only the first value counts — English being in the list does not switch to English.
 */
import { InMemoryStore } from '@aas/store';
import { createApi, createHttpServer, type ApiRequest } from '@aas/api';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const handle = createApi(new InMemoryStore()) as (r: ApiRequest) => Promise<{ status: number; body?: any }>;

const get = (path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
  handle({ method: 'GET', path, query, headers });

describe('server text language', () => {
  it('Korean when no language is sent', async () => {
    const response = await get('/없는-경로');
    expect(response.status).toBe(404);
    expect(response.body.messages[0].text).toBe('경로가 없습니다: GET /없는-경로');
  });

  it('English with Accept-Language: en', async () => {
    const response = await get('/nowhere', { 'accept-language': 'en' });
    expect(response.body.messages[0].text).toBe('No such route: GET /nowhere');
  });

  it('?lang=en takes precedence over the header — for download URLs opened in a new window', async () => {
    const response = await get('/nowhere', { 'accept-language': 'ko' }, { lang: 'en' });
    expect(response.body.messages[0].text).toBe('No such route: GET /nowhere');
  });

  it('only the first value of the browser default list counts', async () => {
    const response = await get('/nowhere', { 'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' });
    expect(response.body.messages[0].text).toBe('경로가 없습니다: GET /nowhere');
  });

  it('languages of two concurrent requests do not mix', async () => {
    const [ko, en] = await Promise.all([get('/a', { 'accept-language': 'ko' }), get('/b', { 'accept-language': 'en' })]);
    expect(ko.body.messages[0].text).toBe('경로가 없습니다: GET /a');
    expect(en.body.messages[0].text).toBe('No such route: GET /b');
  });

  it('login failure message', async () => {
    const login = (headers: Record<string, string>) =>
      handle({ method: 'POST', path: '/auth/login', query: {}, headers, body: { login: 'nobody', password: '틀린비밀번호입니다' } });
    const ko = await login({});
    const en = await login({ 'accept-language': 'en' });
    expect(ko.status).toBe(401);
    expect(ko.body.messages[0].text).toBe('로그인하지 못했습니다 — 이름이나 비밀번호를 확인하십시오.');
    expect(en.body.messages[0].text).toBe('Sign-in failed — check the name or password.');
  });

  it('editing with a read-only token gives 403 — the auth rejection is in that request language too', async () => {
    const guarded = createApi(new InMemoryStore(), { auth: { tokens: ['full'], readOnlyTokens: ['ro'] } }) as typeof handle;
    const write = (headers: Record<string, string>) =>
      guarded({ method: 'POST', path: '/packages', query: { name: 'x.aasx' }, headers: { authorization: 'Bearer ro', ...headers }, body: new Uint8Array() });
    const ko = await write({});
    const en = await write({ 'accept-language': 'en' });
    expect(ko.status).toBe(403);
    expect(ko.body.messages[0].text).toBe('읽기 전용 토큰으로는 고칠 수 없습니다.');
    expect(en.body.messages[0].text).toBe('A read-only token cannot make changes.');
  });

  it('an unknown package is NotFound — errors created deep in routes are translated too', async () => {
    const ko = await get('/packages/없는-패키지/derivation');
    const en = await get('/packages/no-such-package/derivation', { 'accept-language': 'en' });
    expect(ko.status).toBe(404);
    expect(ko.body.messages[0]).toMatchObject({ code: 'NotFound', text: '패키지를 찾을 수 없습니다.' });
    expect(en.body.messages[0]).toMatchObject({ code: 'NotFound', text: 'Package not found.' });
  });

  it('the body limit (413) uses the request language even when sent before reaching createApi — with a real server', async () => {
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
