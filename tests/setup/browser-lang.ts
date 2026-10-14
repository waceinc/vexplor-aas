/**
 * 화면 시험은 **한국어 브라우저**에서 돈다고 둔다.
 *
 * 고른 언어가 없으면 화면이 브라우저 언어를 따르는데(i18n.ts `readLang`, 2026-10-14), jsdom의 브라우저 언어는
 * `en-US`다. 화면 시험 대부분은 한국어 글자로 찾으므로 여기서 한국어 브라우저로 고정한다.
 * 브라우저 언어 판정 자체는 apps/web/test/browser-lang.test.ts가 따로 본다.
 */
const nav = (globalThis as { navigator?: Navigator }).navigator;
// Node에도 navigator가 있다(Node 21+, language = en-US) — 화면 모듈을 node 환경에서 시험할 때도 같게 둔다
if (nav) {
  Object.defineProperty(nav, 'languages', { configurable: true, get: () => ['ko-KR', 'ko'] });
  Object.defineProperty(nav, 'language', { configurable: true, get: () => 'ko-KR' });
}
