/**
 * 서버 글의 언어 — 화면이 고른 언어(Accept-Language · ?lang=)로 오류 · 지적 문구가 나오는가.
 *
 * 🔴 기본은 한국어다. 언어를 싣지 않은 호출자(예전 화면 · 명령줄 · 다른 시스템)가 갑자기 영어를 받으면 안 된다.
 * 🔴 브라우저 기본값(ko-KR,ko;q=0.9,en-US;…)은 첫 값만 본다 — 영어가 목록에 있다고 영어로 가지 않는다.
 */
import { InMemoryStore } from '@aas/store';
import { createApi, type ApiRequest } from '@aas/api';
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
});
