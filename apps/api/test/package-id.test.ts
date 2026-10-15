/**
 * A package id that is not a plain name is the caller's mistake (400), never a server fault (500) — red-team M3 follow-up,
 * 2026-10-16. The folder store refuses such ids because they would become paths outside the data folder.
 */
import { FolderStore } from '@aas/store';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ApiRequest } from '../src/http.js';

const parent = mkdtempSync(join(tmpdir(), 'aas-pkgid-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

type Reply = { status: number; headers: Record<string, string>; body: any };

describe('M3 — an encoded traversal id in the URL', () => {
  it('GET and DELETE answer 400 with a translated message, and nothing outside the data folder is touched', async () => {
    const dataDir = join(parent, 'data');
    const victim = join(parent, 'escape');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep.txt'), 'still here');

    const store = new FolderStore(dataDir);
    await store.init();
    // No workspaces and no auth — the plainest server, where the id reaches the store unchecked by api.ts
    const api = createApi(store) as (r: ApiRequest) => Promise<Reply>;
    const ask = (method: string, lang: string): ApiRequest =>
      ({ method, path: '/packages/..%2Fescape', query: {}, headers: { 'accept-language': lang } }) as ApiRequest;

    for (const method of ['GET', 'DELETE']) {
      const ko = await api(ask(method, 'ko'));
      expect(ko.status).toBe(400);
      expect(ko.body.messages[0].code).toBe('BadRequest');
      expect(ko.body.messages[0].text).toContain('패키지 id');
      const en = await api(ask(method, 'en'));
      expect(en.status).toBe(400);
      expect(en.body.messages[0].text).toContain('package id');
    }
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
  });
});
