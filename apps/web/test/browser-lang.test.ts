/**
 * When no language is chosen, follow the browser language (product owner, 2026-10-14: "prioritize global").
 * Only a Korean browser gets Korean; everything else (including unknown) gets English. An explicit choice wins.
 */
import { describe, expect, it } from 'vitest';
import { browserLang } from '../src/i18n.js';

describe('browser language', () => {
  it('Korean browser gets Korean', () => {
    expect(browserLang(['ko-KR', 'en-US'])).toBe('ko');
    expect(browserLang(['ko'])).toBe('ko');
  });
  it('anything else gets English: English, Japanese, German', () => {
    expect(browserLang(['en-US', 'ko-KR'])).toBe('en');
    expect(browserLang(['ja-JP'])).toBe('en');
    expect(browserLang(['de-DE'])).toBe('en');
  });
  it('unknown gets English', () => {
    expect(browserLang([''])).toBe('en');
  });
});
