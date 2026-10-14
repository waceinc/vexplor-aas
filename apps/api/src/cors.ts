/**
 * CORS — needed only when a **browser app** on another origin calls this API.
 *
 * The authoring UI is served on the same port (static.ts) and development goes through the Vite proxy, so normally there are no
 * cross-origin requests. Server-to-server calls (MES, BaSyx, scripts) have nothing to do with CORS.
 * So by default **no headers are emitted** — the browser blocking is the safest state.
 *
 * List allowed origins comma-separated in `CORS_ORIGIN` to respond only to those origins (`*` means all).
 * Used together with token auth, so credentials are not allowed — the Authorization header is enough.
 */
const ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'authorization, content-type, if-match, if-none-match';
const EXPOSE_HEADERS = 'etag, location, content-disposition';

export interface CorsPolicy {
  /** Allowed origins. If empty, no CORS headers are emitted */
  origins: readonly string[];
}

export function corsFromEnv(env: NodeJS.ProcessEnv): CorsPolicy {
  const raw = env['CORS_ORIGIN']?.trim();
  if (!raw) return { origins: [] };
  return {
    origins: raw
      .split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .filter((item) => item.length > 0),
  };
}

/**
 * CORS headers for this request's Origin. An empty object if not allowed — the browser blocks it on its own.
 * Origin comparison ignores case (scheme and host are case-insensitive) and trailing slashes.
 */
export function corsHeaders(policy: CorsPolicy, origin: string | undefined): Record<string, string> {
  if (!origin || policy.origins.length === 0) return {};
  const wildcard = policy.origins.includes('*');
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  const allowed = wildcard || policy.origins.some((item) => item.toLowerCase() === normalized);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': wildcard ? '*' : origin,
    'access-control-allow-methods': ALLOW_METHODS,
    'access-control-allow-headers': ALLOW_HEADERS,
    'access-control-expose-headers': EXPOSE_HEADERS,
    'access-control-max-age': '600',
    // Responses vary by origin, so keep caches from mixing — harmless even with `*`
    vary: 'Origin',
  };
}

/** Is this a preflight request — OPTIONS + Access-Control-Request-Method */
export function isPreflight(method: string, headers: Record<string, string | string[] | undefined>): boolean {
  return method === 'OPTIONS' && headers['access-control-request-method'] !== undefined;
}
