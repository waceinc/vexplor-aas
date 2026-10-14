/**
 * Screen test harness: wires fetch to the real API handler (@aas/api + in-memory store).
 * A small extract of mountApi from app.test.tsx (no cookies or auth). New screen tests use this.
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

/** Before/after each test: fill in and clear what jsdom lacks */
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

/** Wire the store to the API and expose it as fetch */
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
