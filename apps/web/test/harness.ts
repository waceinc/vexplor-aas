/**
 * 화면 시험 틀 — fetch 를 진짜 API 핸들러(@aas/api + 인메모리 저장소)에 물린다.
 * app.test.tsx 의 mountApi 와 같은 방식을 작게 떼어 냈다(쿠키·인증 없이). 새 화면 시험은 이것을 쓴다.
 */
import { createApi, type ApiOptions, type ApiRequest } from '@aas/api';
import type { InMemoryStore } from '@aas/store';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

/** 각 시험 전후 — jsdom 에 없는 것을 채우고 비운다 */
export function useScreenHarness(): void {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 900, configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}

/** 저장소를 API 에 물려 fetch 로 둔다 */
export function wireFetch(store: InMemoryStore, options: ApiOptions = {}): void {
  const handle = createApi(store, options);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const query: Record<string, string> = {};
    const queryAll: Record<string, string[]> = {};
    for (const [key, value] of url.searchParams) {
      query[key] = value;
      queryAll[key] = [...(queryAll[key] ?? []), value];
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    let body: unknown;
    if (init?.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else if (typeof init?.body === 'string') body = headers['content-type']?.includes('json') ? (JSON.parse(init.body) as unknown) : init.body;
    const response = await handle({ method: init?.method ?? 'GET', path: url.pathname, query, queryAll, headers, ...(body === undefined ? {} : { body }) } as ApiRequest);
    const payload = response.body instanceof Uint8Array ? response.body : response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(response.status === 204 ? null : (payload as BodyInit | null), { status: response.status, headers: response.headers });
  }) as typeof fetch;
}
