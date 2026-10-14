/**
 * jsdom 테스트의 `localStorage`·`sessionStorage`를 jsdom 것으로 되돌린다.
 *
 * 🔴 Node 25부터 Web Storage가 기본으로 켜져 전역에 `localStorage` 게터가 생겼다. `--localstorage-file`을 주지 않으면
 *    이 게터는 `undefined`를 돌려주고, vitest의 jsdom 환경은 이미 있는 전역을 덮지 않아 jsdom의 저장소가 가려진다.
 *    그래서 Node 26에서만 「Cannot read properties of undefined (reading 'removeItem')」로 도움말 테스트 3건이 떨어졌다
 *    (Node 24에서는 같은 테스트가 모두 통과 — 2026-10-13 실측). 제품 코드의 문제가 아니라 시험 환경의 문제다.
 * node 환경 테스트에는 `jsdom` 전역이 없으므로 아무것도 하지 않는다.
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
