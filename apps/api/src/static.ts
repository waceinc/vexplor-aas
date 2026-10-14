/**
 * Static file serving — serves the authoring UI (@aas/web) build output on the **same port** as the API.
 *
 * Why there is no separate nginx:
 *  ① The deployment target is an air-gapped factory server. With a single container, transfer, startup and inspection are done in one go
 *  ② Being the same origin removes the need for CORS and for dev proxy configuration
 *  ③ All this does is "serve files as-is", not complex enough to bring in a web server
 *
 * Important: static files do not require a token. The screen must load for the user to be able to **enter** a token.
 *    All secrets are on the API side; what goes out here is the app shell anyone may receive.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/** Extension → content-type. Not served if absent from the list (we do not guess) */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // Samples (public/samples) — fetched by "Start from a sample"
  '.zip': 'application/zip',
  '.aasx': 'application/asset-administration-shell-package',
};

export interface StaticFile {
  path: string;
  contentType: string;
  size: number;
  /** Only files with a hash baked into the name are cached long-term */
  cacheControl: string;
}

/**
 * Map the request path to a real file under the root. `undefined` if it escapes.
 *
 * The same class of problem as Zip Slip (plan Ⅷ) — as learned there, block it **at the point of reading**.
 */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined; // malformed percent-encoding — do not interpret it
  }
  if (decoded.includes('\0')) return undefined;

  const base = resolve(root);
  // Strip the leading `/` and join to the root. Even if `..` is mixed in, the check below catches it
  const wanted = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(join(base, wanted));
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined;

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;

  const contentType = TYPES[extname(candidate).toLowerCase()];
  if (!contentType) return undefined;

  // Vite bakes hashes into file names under assets/ — the name changes when the content changes, so long caching is safe.
  // index.html is not like that. If it is cached, the old screen remains even after a new version is deployed
  const hashed = /[/\\]assets[/\\]/.test(candidate);
  return {
    path: candidate,
    contentType,
    size: info.size,
    cacheControl: hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
}

export function openStatic(file: StaticFile): NodeJS.ReadableStream {
  return createReadStream(file.path);
}

/** SPA fallback — serve the app shell even for unknown paths (for refreshes and bookmarks) */
export function isDocumentRequest(method: string, accept: string | undefined): boolean {
  return (method === 'GET' || method === 'HEAD') && (accept ?? '').includes('text/html');
}
