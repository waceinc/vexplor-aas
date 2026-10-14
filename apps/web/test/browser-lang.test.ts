/**
 * 고른 언어가 없을 때 — 브라우저 언어를 따른다(대표 2026-10-14 「글로벌을 우선시」).
 * 한국어 브라우저만 한국어, 그 밖(모르는 경우 포함)은 영어. 고른 것이 있으면 그것이 먼저다.
 */
import { describe, expect, it } from 'vitest';
import { browserLang } from '../src/i18n.js';

describe('브라우저 언어', () => {
  it('한국어 브라우저는 한국어', () => {
    expect(browserLang(['ko-KR', 'en-US'])).toBe('ko');
    expect(browserLang(['ko'])).toBe('ko');
  });
  it('그 밖은 영어 — 영어 · 일본어 · 독일어', () => {
    expect(browserLang(['en-US', 'ko-KR'])).toBe('en');
    expect(browserLang(['ja-JP'])).toBe('en');
    expect(browserLang(['de-DE'])).toBe('en');
  });
  it('알 수 없으면 영어', () => {
    expect(browserLang([''])).toBe('en');
  });
});
