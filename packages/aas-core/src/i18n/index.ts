/**
 * Language of text the server produces — linter finding messages · rule descriptions · reports · API errors.
 *
 * Uses **the same convention** as the UI (apps/web/src/i18n.ts).
 * - The Korean text itself is the dictionary key. `tr('되돌릴 변경이 없습니다.')`
 * - Sentences with values are translated whole, and only the slots are filled. `fill(tr('패키지 {0}을(를) 찾을 수 없습니다.'), { 0: id })`
 * - If missing from the dictionary, the Korean goes out as-is — the worst case is "untranslated".
 *
 * Important: **the language is not passed down as a parameter.** Errors are created deep inside the store,
 *    collector, and linter — threading the language through every call site means one spot gets missed and
 *    that sentence alone stays Korean. Instead, the outside plugs in **one function that asks for the current
 *    language**: the API per request (AsyncLocalStorage), the UI from its setting.
 *    If nobody plugs one in, it is Korean (tests · CLI · older callers).
 * Important: **when you write a new Korean sentence, wrap it in `tr()` and add it to the en/ dictionary.**
 *    Missing one stops CI (`node scripts/i18n-scan.mjs --check` — it counts server packages too).
 */
import { EN_CORE } from './en/core.js';
import { EN_LINTER_RULES } from './en/linter-rules.js';
import { EN_LINTER_TEXT } from './en/linter-text.js';
import { EN_LINTER_DPP } from './en/linter-dpp.js';
import { EN_LINTER_VERSION } from './en/linter-version.js';
import { EN_API } from './en/api.js';
import { EN_BUNDLE } from './en/bundle.js';
import { EN_PACKAGES } from './en/packages.js';
import { EN_INTEGRATION_CORE } from './en/integration-core.js';
import { EN_INTEGRATION_STORE } from './en/integration-store.js';
import { EN_INTEGRATION_RUNTIME } from './en/integration-runtime.js';
import { EN_INTEGRATION_API } from './en/integration-api.js';
import { EN_INTEGRATION_EXPORTS } from './en/integration-exports.js';
import { EN_EDGE } from './en/edge.js';

export type Lang = 'ko' | 'en';

let source: () => Lang = () => 'ko';

/** Plugs in the function that reports the current language. Per request for the API, the setting for the UI */
export function setLangSource(get: () => Lang): void {
  source = get;
}

export function currentLang(): Lang {
  try {
    return source();
  } catch {
    // Text must go out even if the language cannot be determined — fall back to Korean
    return 'ko';
  }
}

/** Picks the language from an `Accept-Language` or `?lang=` value. Unknown values mean Korean */
export function parseLang(value: string | undefined | null): Lang {
  if (!value) return 'ko';
  const first = value.split(',')[0]!.trim().toLowerCase();
  return first.startsWith('en') ? 'en' : 'ko';
}

const DICTIONARIES: readonly Record<string, string>[] = [
  EN_CORE,
  EN_LINTER_RULES,
  EN_LINTER_TEXT,
  EN_LINTER_DPP,
  EN_LINTER_VERSION,
  EN_API,
  EN_BUNDLE,
  EN_PACKAGES,
  EN_INTEGRATION_CORE,
  EN_INTEGRATION_STORE,
  EN_INTEGRATION_RUNTIME,
  EN_INTEGRATION_API,
  EN_INTEGRATION_EXPORTS,
  EN_EDGE,
];

/** Looks up the English dictionary. undefined if absent */
export function lookupEn(text: string): string | undefined {
  for (const dictionary of DICTIONARIES) {
    const found = dictionary[text];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** One string in the current language. If missing from the dictionary, the given Korean as-is */
export function tr(text: string, lang: Lang = currentLang()): string {
  return lang === 'ko' ? text : (lookupEn(text) ?? text);
}

/**
 * Slot substitution — replaces all at once. Replacing one at a time would also replace a `{1}` inside a value
 * inserted earlier on the next pass (file names and user input can be anything).
 */
export function fill(text: string, values: Record<string, string | number | boolean | undefined | null>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key] ?? '') : whole));
}
