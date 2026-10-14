/**
 * Screen tests assume a **Korean browser**.
 *
 * With no chosen language, the UI follows the browser language (i18n.ts `readLang`, 2026-10-14), and jsdom's browser language
 * is `en-US`. Most screen tests look things up by Korean text, so pin a Korean browser here.
 * Browser language detection itself is covered separately by apps/web/test/browser-lang.test.ts.
 */
const nav = (globalThis as { navigator?: Navigator }).navigator;
// Node has navigator too (Node 21+, language = en-US): keep it the same when testing UI modules in the node environment
if (nav) {
  Object.defineProperty(nav, 'languages', { configurable: true, get: () => ['ko-KR', 'ko'] });
  Object.defineProperty(nav, 'language', { configurable: true, get: () => 'ko-KR' });
}
