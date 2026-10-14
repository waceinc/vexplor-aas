/**
 * Restores jsdom's own `localStorage`/`sessionStorage` for jsdom tests.
 *
 * Important: since Node 25, Web Storage is on by default and a global `localStorage` getter exists. Without `--localstorage-file`
 *    that getter returns `undefined`, and vitest's jsdom environment does not overwrite existing globals, so jsdom's storage is hidden.
 *    That is why only on Node 26 three help tests failed with "Cannot read properties of undefined (reading 'removeItem')"
 *    (on Node 24 the same tests all pass, measured 2026-10-13). It is a test environment problem, not a product code problem.
 * Node-environment tests have no `jsdom` global, so this does nothing.
 */
interface JsdomHandle {
  window: { localStorage: Storage; sessionStorage: Storage };
}

const handle = (globalThis as { jsdom?: JsdomHandle }).jsdom;
if (handle) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get: () => handle.window[key],
    });
  }
}
