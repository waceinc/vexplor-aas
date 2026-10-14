/**
 * Per-request language — server-generated text (errors, findings, reports) is produced in that request's language.
 *
 * The UI sends `Accept-Language`, and download URLs opened in a new window append `?lang=en`.
 * Important: the language is set in this one place and picked up by `tr()` in `@aas/core` — routes, store and linter
 *    do not carry it around as a parameter (same approach as "who" in actor.ts).
 * Important: for the browser default `Accept-Language` (ko-KR,ko;q=0.9,en…) only the first value is used — only people who chose
 *    the English UI get English. Unknown values mean Korean.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseLang, setLangSource, type Lang } from '@aas/core';
import type { ApiRequest } from './http.js';

const storage = new AsyncLocalStorage<Lang>();

setLangSource(() => storage.getStore() ?? 'ko');

/** This request's language — `?lang=` first, then `Accept-Language` */
export function langOf(request: ApiRequest): Lang {
  const fromQuery = request.query['lang'];
  if (fromQuery) return parseLang(fromQuery);
  return parseLang(request.headers['accept-language']);
}

/**
 * Pick the language from a raw request (node:http) — places that answer outside createApi (413 body cap, static files,
 * preflight) must follow the same rule. The rule matches langOf: `?lang=` first, then `Accept-Language`
 */
export function langOfRaw(url: string | undefined, acceptLanguage: string | string[] | undefined): Lang {
  const fromQuery = new URL(url ?? '/', 'http://localhost').searchParams.get('lang');
  if (fromQuery) return parseLang(fromQuery);
  return parseLang(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage);
}

/**
 * Language of the startup log operators see — English if `AAS_LANG=en`. Korean by default.
 * Important: the OS LANG is ignored — dev PCs used in Korean are often en_US, which would switch it unexpectedly
 */
export function bootLang(env: Record<string, string | undefined>): Lang {
  return parseLang(env['AAS_LANG']);
}

export function runInLang<T>(lang: Lang, fn: () => T): T {
  return storage.run(lang, fn);
}
