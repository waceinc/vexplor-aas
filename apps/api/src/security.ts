/**
 * Security headers and the CSRF origin check — things that became necessary once login was introduced (plan A8).
 *
 * When only tokens were used, the browser never attached credentials **automatically**. Cookie sessions differ —
 * the browser attaches them on its own, so if another site gets the browser to send a request to our server,
 * our cookie rides along with that request (CSRF). So we block it in two layers.
 *
 *   1. `SameSite=Strict` cookie — requests coming from another site carry no cookie at all (routes/auth.ts)
 *   2. The origin check here — a backstop for cases where 1 does not hold (old browsers, another app on the same site)
 *
 * Important: **why 1 alone is not considered enough**: SameSite is a promise the browser keeps, and
 *    "same site" is per registrable domain, so `a.example.com` calling `b.example.com`
 *    counts as the same site. Several hosts on an internal network is a common setup.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { errorResponse, type ApiRequest, type ApiResponse } from './http.js';
import { tr } from '@aas/core';

/** Methods that change state — only these have their origin checked */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Headers attached to every response.
 *
 * Important: HSTS is attached only when `https` is true. If a server receiving plain HTTP announces HSTS,
 *    browsers lock that host into opening **over HTTPS only** — everyone who used the internal http address
 *    is locked out at once. Undoing it requires fixing each person's browser.
 */
export function securityHeaders(https: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    // Prevent interpretation as a type other than declared — cuts off the path for an uploaded file to run as a script
    'x-content-type-options': 'nosniff',
    // URLs contain package ids and identifiers, so do not leak them outside
    'referrer-policy': 'no-referrer',
    // For old browsers that don't know CSP frame-ancestors — says the same thing twice
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // Prevents embedding our screen in someone else's page and hijacking clicks (clickjacking)
      "frame-ancestors 'none'",
      "form-action 'self'",
      // blob: — used when converting diagram SVG to PNG via canvas (DocAssets.tsx)
      "img-src 'self' data: blob:",
      // Important: 'unsafe-inline' applies only to style. React sets style attributes directly,
      //    so removing it breaks the UI. It is not added to script — that is where the real risk is
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
    ].join('; '),
  };
  if (https) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/**
 * In the demo, is this an **address the server may connect out to** — only the virtual PLC inside the tool.
 *
 * Important: "Import from equipment" and "Collection" make **the server** connect to an address the visitor typed. Leaving this open
 *    on a public demo lets anyone use the server as a stepping stone to probe the internal network the server sits on
 *    (office devices, routers) (SSRF — the connection failure reason reveals "open/closed"). Found in the 2026-10-08 review.
 *    The demo's purpose is to show features, so the virtual PLC is enough; connecting to real equipment is for the installed edition.
 * Important: looks only at the address **string** (no DNS resolution). All names are blocked so names cannot be used to bypass —
 *    what is allowed is the literal loopback IP and the single virtual PLC port.
 */
export function demoOutboundAllowed(endpoint: string, simulatorPort: number): boolean {
  const match = /^opc\.tcp:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?(?:\/|$)/i.exec(endpoint.trim());
  if (!match) return false;
  const host = (match[1] ?? '').toLowerCase();
  const port = Number(match[2] ?? 4840);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host) && port === simulatorPort;
}

/** Outbound connection blocked in the demo — routes recognize it by name and return 403 */
export class OutboundBlockedError extends Error {
  constructor() {
    super(tr('체험판에서는 도구 안의 가상 PLC에만 연결할 수 있습니다. 실제 설비 연결은 직접 설치한 서버에서 하십시오.'));
    this.name = 'OutboundBlockedError';
  }
}

/** Determine "did this request come over HTTPS" even behind a proxy */
export function isHttps(headers: Record<string, string | string[] | undefined>, encrypted: boolean): boolean {
  if (encrypted) return true;
  // Important: this value is set by a reverse proxy (Caddy, nginx). **It can only be trusted behind a proxy** —
  //    if the server is exposed directly, anyone can send this header. So no door is opened by it;
  //    it only decides whether to attach HSTS (attaching it wrongly hurts us, not an attacker)
  const forwarded = headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? '').split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * Did this request **come from another site**.
 *
 * Only state changes arriving via cookie are checked:
 *  - An API key (Authorization header) cannot be attached by another site — doing so requires passing a CORS preflight,
 *    and we do not allow credentialed CORS (cors.ts)
 *  - Reads (GET, HEAD) change nothing
 *
 * Important: `Origin: null` is **refused** — it is exactly what a sandboxed iframe or a `data:` page sends. It used to be
 *    let through with a missing Origin as "not a browser" (red-team L2, 2026-10-16).
 * Important: a **missing** Origin is refused when the browser says where the request came from (`Sec-Fetch-Site`) and
 *    it is not same-origin. Only a request carrying neither header passes: every browser that sends Sec-Fetch-Site
 *    also sends Origin on writes, so "neither" means a non-browser client (curl, scripts), which cannot hold a
 *    victim's cookie. The pre-2019 browsers that sent neither are covered by the SameSite=Strict cookie.
 */
export function crossSiteWrite(
  request: ApiRequest,
  allowedOrigins: readonly string[],
): ApiResponse | undefined {
  if (!MUTATING.has(request.method)) return undefined;
  const origin = request.headers['origin'];
  const site = request.headers['sec-fetch-site'];
  if (origin === 'null') return site === 'same-origin' ? undefined : refused();
  if (!origin) return site === undefined || site === 'same-origin' ? undefined : refused();

  // Important: behind a proxy, `Host` may have been changed. Caddy passes the original value through, but
  //    nginx defaults to the **upstream address** (127.0.0.1:8080), so comparing as-is makes **every write**
  //    by a logged-in user a **403**. Check the original host reported by the proxy first.
  //    Why trusting this header is fine: spoofing it only makes the request look "from itself",
  //    and another site cannot choose Origin — the browser decides and sends it.
  for (const host of [request.headers['x-forwarded-host'], request.headers['host']]) {
    if (host !== undefined && host !== '' && sameOrigin(origin, host)) return undefined;
  }
  // Important: `CORS_ORIGIN=*` is about response headers for anonymous reads — it never means "trust every site's
  //    cookie writes" (red-team L11). Only origins named one by one count here
  if (allowedOrigins.some((allowed) => allowed !== '*' && normalize(allowed) === normalize(origin))) return undefined;
  return refused();
}

function refused(): ApiResponse {
  return errorResponse(
    403,
    'Forbidden',
    tr('다른 사이트에서 보낸 요청은 받지 않습니다. 브라우저 주소창의 주소로 직접 접속하십시오.'),
  );
}

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Does Origin's host:port equal Host — the scheme is not compared since a proxy may change it.
 * With multiple proxies `X-Forwarded-Host` is comma-joined, so use the first entry (the original connection).
 */
function sameOrigin(origin: string, host: string): boolean {
  const first = host.split(',')[0]?.trim() ?? '';
  if (first === '') return false;
  try {
    return new URL(origin).host.toLowerCase() === first.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * **Setup code** that prevents anyone from claiming the first-admin creation first.
 *
 * Important: why it is needed (found on 2026-10-02). `/auth/setup` must be callable by anyone while
 *    no account exists — that is how the first admin is created. But if the server is exposed,
 *    **anyone on the same network can call it first and become admin**, and the actual operator gets blocked with 409.
 *    The setup `.env.example` recommended (AAS_ALLOW_OPEN=1, no token) was exactly that state.
 *
 * The way to block it is to ask "is this someone who can touch the server". Any one of three passes:
 *   1. A server bound **to this computer only** (protected mode) — the person is sitting at the server
 *   2. A valid API key — a secret the operator already holds
 *   3. The **setup code** printed in the startup log — being able to read the log means being able to touch the server
 *
 * The code is generated once per process (it changes when the server restarts). It can also be set
 * directly via `AAS_SETUP_CODE` — for deployments where container logs are hard to read.
 */
let processCode: string | undefined;

export function setupCode(env: Record<string, string | undefined>): string {
  const explicit = env['AAS_SETUP_CODE']?.trim();
  if (explicit) return explicit;
  processCode ??= randomBytes(6).toString('hex');
  return processCode;
}

/** Whether to ask for the setup code — servers bound to this computer only do not ask */
export function setupCodeRequired(protectedBind: boolean): boolean {
  return !protectedBind;
}

/** Compare without leaking through timing even when lengths differ */
export function sameCode(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    // Different lengths are wrong anyway. Still compare against itself once to spend the same time
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Where the request came from — used by the signup rate limit.
 *
 * Important: `X-Forwarded-For` **can be spoofed.** So no door is opened by it; it is only used for counting.
 *    Spoofing can dodge the per-address cap but not the global cap (session.ts SignupThrottle).
 */
export function clientAddress(request: ApiRequest): string | undefined {
  // Important: use the **last** entry (2026-10-06 security review). Earlier entries may be written by the client,
  //    and proxies (Caddy, Cloudflare) **append** the address they saw. Using the first entry
  //    let one header rotate addresses to evade the attempt limit.
  //    (This server runs only behind a proxy — the app port is bound to 127.0.0.1 only)
  const forwarded = request.headers['x-forwarded-for'];
  const last = forwarded?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return last || request.remoteAddress;
}
