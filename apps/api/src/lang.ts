/**
 * 요청마다의 언어 — 서버가 만드는 글(오류 · 지적 문구 · 결과서)을 그 요청의 언어로 낸다.
 *
 * 화면은 `Accept-Language`를 싣고, 새 창으로 여는 내려받기 주소는 `?lang=en`을 붙인다.
 * 🔴 언어는 여기 한 곳에서 깔고 `@aas/core`의 `tr()`가 집어 쓴다 — 라우트 · 저장소 · 린터가
 *    매개변수로 들고 다니지 않는다(actor.ts의 「누가」와 같은 방식).
 * 🔴 브라우저 기본 `Accept-Language`(ko-KR,ko;q=0.9,en…)는 첫 값만 본다 — 영어 화면을 고른
 *    사람만 영어를 받는다. 모르는 값은 한국어다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseLang, setLangSource, type Lang } from '@aas/core';
import type { ApiRequest } from './http.js';

const storage = new AsyncLocalStorage<Lang>();

setLangSource(() => storage.getStore() ?? 'ko');

/** 이 요청의 언어 — `?lang=`이 먼저, 그다음 `Accept-Language` */
export function langOf(request: ApiRequest): Lang {
  const fromQuery = request.query['lang'];
  if (fromQuery) return parseLang(fromQuery);
  return parseLang(request.headers['accept-language']);
}

/**
 * 날것의 요청(node:http)에서 언어를 고른다 — createApi 밖에서 답하는 자리(본문 상한 413 · 정적 파일 ·
 * 사전 요청)도 같은 규칙으로 나가야 한다. 규칙은 langOf와 같다: `?lang=`이 먼저, 그다음 `Accept-Language`
 */
export function langOfRaw(url: string | undefined, acceptLanguage: string | string[] | undefined): Lang {
  const fromQuery = new URL(url ?? '/', 'http://localhost').searchParams.get('lang');
  if (fromQuery) return parseLang(fromQuery);
  return parseLang(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage);
}

/**
 * 운영자가 보는 기동 로그의 언어 — `AAS_LANG=en`이면 영어. 기본은 한국어다.
 * 🔴 OS의 LANG은 보지 않는다 — 한국어로 쓰는 개발 PC도 en_US인 경우가 흔해서 갑자기 바뀐다
 */
export function bootLang(env: Record<string, string | undefined>): Lang {
  return parseLang(env['AAS_LANG']);
}

export function runInLang<T>(lang: Lang, fn: () => T): T {
  return storage.run(lang, fn);
}
