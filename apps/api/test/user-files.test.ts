/**
 * Stored files that users upload must never be served as something a browser runs (red-team H1, 2026-10-16).
 *
 * The attack: put an HTML page and a script into two thumbnails, then send a victim the HTML thumbnail URL. The page
 * opened inline on our origin, its `<script src>` loaded the second thumbnail (same origin, so `script-src 'self'`
 * allowed it) and the script read everything the victim could see.
 *
 * What must hold, whatever the uploader claims:
 *   - a thumbnail is a raster image (checked by its bytes) — anything else is refused on upload
 *   - every file GET is inline only when its bytes are a passive type (raster image, PDF); otherwise it is an
 *     opaque download, and every such response carries a sandbox CSP
 *   - the demo account's "no downloads" rule is decided by what the route does, not only by response headers
 */
import { readAasx, writeAasx } from '@aas/aasx';
import { InMemoryStore } from '@aas/store';
import { createApi, encodeIdentifier, type ApiRequest } from '@aas/api';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemoUser } from '../src/demo.js';
import { hashPassword } from '../src/password.js';
import { BUNDLE_PART_PREFIX } from '../src/routes/bundle-files.js';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-roll-forming-machine.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);
const shellId = golden.environment.assetAdministrationShells![0]!.id;

type Reply = { status: number; headers: Record<string, string>; body: any };
let handle: (request: ApiRequest) => Promise<Reply>;
let packageId: string;
let store: InMemoryStore;

async function call(
  method: string,
  path: string,
  init: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return handle({
    method,
    path,
    query: init.query ?? {},
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = text('<!doctype html><script src="/x.js"></script>');
const thumbPath = (): string => `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(shellId)}/asset-information/thumbnail`;

/** The headers every user-file response must carry, whatever the type */
function expectSandboxed(reply: Reply): void {
  const csp = reply.headers['content-security-policy'] ?? '';
  expect(csp).toContain('sandbox');
  expect(csp).toContain("default-src 'none'");
}

function expectOpaqueDownload(reply: Reply): void {
  expect(reply.status).toBe(200);
  expect(reply.headers['content-type']).toBe('application/octet-stream');
  expect(reply.headers['content-disposition'] ?? '').toMatch(/^attachment/);
  expectSandboxed(reply);
}

beforeEach(async () => {
  store = new InMemoryStore();
  await store.init();
  handle = createApi(store) as typeof handle;
  const created = await call('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN } });
  expect(created.status).toBe(201);
  packageId = created.body.packageId;
});

describe('H1 — a thumbnail upload must be a raster image', () => {
  for (const [label, contentType, data, name] of [
    ['HTML', 'text/html', HTML, 'loader.html'],
    ['JavaScript', 'application/javascript', text('document.title=1'), 'p.js'],
    ['SVG (can carry script)', 'image/svg+xml', text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 'a.svg'],
    ['HTML bytes claiming to be PNG', 'image/png', HTML, 'fake.png'],
  ] as const) {
    it(`rejects ${label} with 400`, async () => {
      const put = await call('PUT', thumbPath(), { body: data, query: { fileName: name }, headers: { 'content-type': contentType } });
      expect(put.status).toBe(400);
      // The original thumbnail is still the one served
      const got = await call('GET', thumbPath());
      expect(got.headers['content-type']).toBe('image/png');
    });
  }

  it('accepts a real PNG and serves it inline as an image, sandboxed', async () => {
    const put = await call('PUT', thumbPath(), { body: PNG, query: { fileName: 'photo.png' }, headers: { 'content-type': 'image/png' } });
    expect(put.status).toBe(204);
    const got = await call('GET', thumbPath());
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    // Inline — an <img> tag must keep working
    expect(got.headers['content-disposition']).toBeUndefined();
    expectSandboxed(got);
  });
});

describe('H1 — a thumbnail imported inside an AASX is stored with a safe type', () => {
  it('an HTML thumbnail declared text/html is kept as bytes but never served as HTML', async () => {
    const evil = writeAasx({ ...golden, thumbnail: { part: '/thumbnail.png', contentType: 'text/html', data: HTML } });
    const created = await call('POST', '/packages', { body: evil, query: { name: 'evil.aasx' } });
    expect(created.status).toBe(201);
    packageId = created.body.packageId;

    const got = await call('GET', thumbPath());
    expectOpaqueDownload(got);
    expect(got.body).toEqual(HTML);
    // And the stored type itself is no longer the attacker's
    const exported = readAasx((await call('GET', `/packages/${packageId}`)).body as Uint8Array);
    expect(exported.thumbnail?.contentType).not.toBe('text/html');
  });
});

describe('H1 — File attachments are inline only for passive types', () => {
  async function attachmentPath(): Promise<string> {
    const hando = golden.environment.submodels!.find((s) => s.idShort === 'HandoverDocumentation')!;
    const smBase = `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(hando.id)}`;
    for (const path of (await call('GET', `${smBase}/$path`)).body as string[]) {
      const meta = await call('GET', `${smBase}/submodel-elements/${path}/$metadata`);
      if (meta.status === 200 && meta.body.modelType === 'File') return `${smBase}/submodel-elements/${path}/attachment`;
    }
    throw new Error('no File element in the fixture');
  }

  it('an HTML attachment comes back as an opaque download', async () => {
    const path = await attachmentPath();
    const put = await call('PUT', path, { body: HTML, query: { fileName: 'x.html' }, headers: { 'content-type': 'text/html' } });
    expect(put.status).toBe(204);
    expectOpaqueDownload(await call('GET', path));
  });

  it('a PDF whose bytes are PDF opens inline', async () => {
    const path = await attachmentPath();
    const pdf = text('%PDF-1.7 manual');
    await call('PUT', path, { body: pdf, query: { fileName: 'manual.pdf' }, headers: { 'content-type': 'application/pdf' } });
    const got = await call('GET', path);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-disposition']).toBeUndefined();
    expect(got.body).toEqual(pdf);
  });

  it('HTML bytes labelled application/pdf are not served as PDF', async () => {
    const path = await attachmentPath();
    await call('PUT', path, { body: HTML, query: { fileName: 'x.pdf' }, headers: { 'content-type': 'application/pdf' } });
    expectOpaqueDownload(await call('GET', path));
  });

  it('a bundle attachment typed by its extension (SVG can carry script) is an opaque download too', async () => {
    const path = '01_UseCase문서/x.svg';
    // Stored directly — the upload route needs a process (bundle) file, which is beside the point here
    await store.putPackageFile(packageId, {
      part: `${BUNDLE_PART_PREFIX}${path}`,
      role: 'bundle',
      contentType: 'image/svg+xml',
      data: text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
    });
    expectOpaqueDownload(await call('GET', `/packages/${packageId}/bundle/files`, { query: { path } }));
  });
});

describe('H1 / D4 — the demo account download rule follows what the route does', () => {
  const DEMO = { login: 'admin', password: '1234', displayName: 'Demo', role: 'editor' as const, resetMinutes: 60 };

  it('blocks attachment and AASX serialization downloads, but still shows the thumbnail', async () => {
    const store = new InMemoryStore();
    await store.init();
    await seedDemoUser(store, DEMO, hashPassword);
    handle = createApi(store, { demo: DEMO, signup: { role: 'editor' } }) as typeof handle;
    const login = await call('POST', '/auth/login', { body: { login: 'admin', password: '1234' } });
    const cookie = (login.headers['set-cookie'] ?? '').split(';')[0]!;
    const headers = { cookie };
    const created = await call('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN }, headers });
    packageId = created.body.packageId;

    // A PDF attachment carries no content-disposition, so a header-only check let it out
    const hando = golden.environment.submodels!.find((s) => s.idShort === 'HandoverDocumentation')!;
    const smBase = `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(hando.id)}`;
    let attachment = '';
    for (const path of (await call('GET', `${smBase}/$path`, { headers })).body as string[]) {
      const meta = await call('GET', `${smBase}/submodel-elements/${path}/$metadata`, { headers });
      if (meta.status === 200 && meta.body.modelType === 'File') attachment = `${smBase}/submodel-elements/${path}/attachment`;
    }
    expect(attachment).not.toBe('');
    await call('PUT', attachment, { body: text('%PDF-1.7 x'), query: { fileName: 'm.pdf' }, headers: { ...headers, 'content-type': 'application/pdf' } });
    expect((await call('GET', attachment, { headers })).status).toBe(403);

    // The whole package through the Part 2 serialization route is a download as well
    const serialized = await call('GET', `/packages/${packageId}/api/v3.0/serialization`, {
      headers: { ...headers, accept: 'application/asset-administration-shell-package+xml' },
    });
    expect(serialized.status).toBe(403);

    // Viewing is not a download — the thumbnail still shows in an <img>
    const thumb = await call('GET', thumbPath(), { headers });
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/png');
  });
});
