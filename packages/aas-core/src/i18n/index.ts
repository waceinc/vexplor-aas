/**
 * 서버가 만드는 글의 언어 — 린터 지적 문구 · 규칙 설명 · 결과서 · API 오류.
 *
 * 화면(apps/web/src/i18n.ts)과 **같은 약속**을 쓴다.
 * - 한국어 글자 자체가 사전의 열쇠다. `tr('되돌릴 변경이 없습니다.')`
 * - 값이 들어가는 문장은 통째로 옮기고 자리만 채운다. `fill(tr('패키지 {0}을(를) 찾을 수 없습니다.'), { 0: id })`
 * - 사전에 없으면 한국어가 그대로 나간다 — 최악이 「안 번역됨」이다.
 *
 * 🔴 **언어는 매개변수로 내려 주지 않는다.** 오류는 저장소 · 수집기 · 린터 깊은 곳에서 만들어진다 —
 *    호출 자리마다 언어를 꿰면 한 군데가 빠져 그 문장만 한국어로 남는다. 대신 **지금 언어를 묻는 함수**
 *    하나를 바깥이 끼운다: API는 요청마다(AsyncLocalStorage), 화면은 설정 값을.
 *    아무도 끼우지 않으면 한국어다(시험 · 명령줄 · 예전 호출자).
 * 🔴 **새 한국어 문장을 적으면 `tr()`로 감싸고 en/ 사전에 넣는다.** 빠뜨리면 CI가 멈춘다
 *    (`node scripts/i18n-scan.mjs --check` — 서버 패키지까지 센다).
 */
import { EN_CORE } from './en/core.js';
import { EN_LINTER_RULES } from './en/linter-rules.js';
import { EN_LINTER_TEXT } from './en/linter-text.js';
import { EN_API } from './en/api.js';
import { EN_BUNDLE } from './en/bundle.js';
import { EN_PACKAGES } from './en/packages.js';

export type Lang = 'ko' | 'en';

let source: () => Lang = () => 'ko';

/** 지금 언어를 알려 줄 함수를 끼운다. API는 요청별, 화면은 설정 값 */
export function setLangSource(get: () => Lang): void {
  source = get;
}

export function currentLang(): Lang {
  try {
    return source();
  } catch {
    // 언어를 못 알아내도 글은 나가야 한다 — 한국어로 간다
    return 'ko';
  }
}

/** `Accept-Language` · `?lang=` 값에서 언어를 고른다. 모르는 값은 한국어 */
export function parseLang(value: string | undefined | null): Lang {
  if (!value) return 'ko';
  const first = value.split(',')[0]!.trim().toLowerCase();
  return first.startsWith('en') ? 'en' : 'ko';
}

const DICTIONARIES: readonly Record<string, string>[] = [
  EN_CORE,
  EN_LINTER_RULES,
  EN_LINTER_TEXT,
  EN_API,
  EN_BUNDLE,
  EN_PACKAGES,
];

/** 영어 사전에서 찾는다. 없으면 undefined */
export function lookupEn(text: string): string | undefined {
  for (const dictionary of DICTIONARIES) {
    const found = dictionary[text];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 글자 하나를 지금 언어로. 사전에 없으면 받은 한국어 그대로 */
export function tr(text: string, lang: Lang = currentLang()): string {
  return lang === 'ko' ? text : (lookupEn(text) ?? text);
}

/**
 * 자리 치환 — 한 번에 갈아 끼운다. 하나씩 바꾸면 먼저 넣은 값 안의 `{1}`까지 다음 차례에 바뀐다
 * (파일 이름 · 사용자 입력은 무엇이든 될 수 있다).
 */
export function fill(text: string, values: Record<string, string | number | boolean | undefined | null>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key] ?? '') : whole));
}
