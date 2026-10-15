/**
 * How files that users put into the tool are handed back to a browser (red-team H1, 2026-10-16).
 *
 * Thumbnails, File attachments and bundle attachments are bytes an uploader chose, stored with a type the uploader
 * chose. Serving them inline with that type let an "image" be an HTML page on our origin, which loaded a second
 * "image" as a same-origin script — `script-src 'self'` allowed it, because it was ours.
 *
 * Important: **the bytes decide, never the declared type.** A file is served inline only when its first bytes are
 *    one of a few passive formats, and then with the type the bytes prove. Everything else leaves as an opaque
 *    `application/octet-stream` attachment, which a browser neither renders nor runs (with `nosniff`).
 * Important: every such response also carries a sandbox CSP. Even if a passive check were ever wrong, the document
 *    would get a unique opaque origin with scripts off — it could not read our cookies or call our API.
 */
import type { AasxPackage } from '@aas/aasx';

import type { ApiResponse } from './http.js';

/** Raster images a browser draws but never executes — the only types a thumbnail may have */
export type RasterType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
type PassiveType = RasterType | 'application/pdf';

const startsWith = (data: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  data.length >= at + prefix.length && prefix.every((byte, i) => data[at + i] === byte);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * Raster type proven by the file's leading bytes, or undefined.
 * Important: no SVG — it is XML that can carry `<script>`, so it is not a passive image.
 */
export function rasterTypeOf(data: Uint8Array): RasterType | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

function passiveTypeOf(data: Uint8Array): PassiveType | undefined {
  return rasterTypeOf(data) ?? (startsWith(data, ascii('%PDF-')) ? 'application/pdf' : undefined);
}

/**
 * Sandbox for user files. `default-src 'none'` stops the document loading anything; `sandbox` gives it an opaque
 * origin with scripts, forms and plugins off.
 * Important: PDFs get no `sandbox` token — Chromium and Firefox refuse to start their built-in PDF viewer in a
 *    sandboxed document, so "open the manual" would turn into a blank page. A PDF does not run script on our origin
 *    in either viewer; `default-src 'none'` still applies to it.
 */
const SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'";

/**
 * Response for a stored user file.
 * @param filename — name offered when the file is downloaded rather than shown
 */
export function userFileResponse(data: Uint8Array, filename?: string): ApiResponse {
  const passive = passiveTypeOf(data);
  if (passive) {
    return {
      status: 200,
      headers: {
        'content-type': passive,
        'content-security-policy': passive === 'application/pdf' ? PDF_CSP : SANDBOX_CSP,
      },
      body: data,
    };
  }
  const name = filename ? encodeURIComponent(filename) : 'download';
  return {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="download"; filename*=UTF-8''${name}`,
      'content-security-policy': SANDBOX_CSP,
    },
    body: data,
  };
}

/**
 * Thumbnail as stored on import: the bytes are kept (lossless), only the type is replaced by what they prove.
 * Important: a thumbnail declared `text/html` inside someone's AASX must not be stored as `text/html` — the next
 *    reader of that value (an export, a future route) should not have to know it was hostile.
 */
export function withSafeThumbnail<T extends AasxPackage>(pkg: T): T {
  if (!pkg.thumbnail) return pkg;
  const proven = rasterTypeOf(pkg.thumbnail.data) ?? 'application/octet-stream';
  if (proven === pkg.thumbnail.contentType) return pkg;
  return { ...pkg, thumbnail: { ...pkg.thumbnail, contentType: proven } };
}
