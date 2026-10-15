/**
 * Access control — token based.
 *
 * Air-gapped factory servers are the main deployment target (spec VIII). So instead of introducing account and session management
 * it only checks **tokens handed out in advance**. No dependencies are added (nor license reviews),
 * and what passes and what is blocked can all be read in one file.
 *
 * Three decisions were made.
 *  1. With no token configured, access is open — so as not to break development and demos.
 *     But since it **must not be silently open**, the server warns at startup and also shows it in `/health`
 *  2. A separate read-only token can be set. There is no reason to give reviewers edit rights
 *  3. Token comparison is done in **constant time**. String comparison returns faster at the first mismatching position,
 *     so the token could be discovered one character at a time from response times
 */
import { timingSafeEqual } from 'node:crypto';
import { errorResponse, type ApiRequest, type ApiResponse } from './http.js';
import { tr } from '@aas/core';

export type AccessLevel = 'full' | 'read-only';

/**
 * The logged-in person — resolved from the session.
 * Important: reaching this point means **the session is already alive**. auth.ts does not check again.
 */
export interface Principal {
  userId: string;
  /** Login name — used to tell whether this is the demo account (demo.ts) */
  login: string;
  role: 'admin' | 'editor' | 'viewer';
  /** Display name at the time — copied as-is into the audit record (past records don't change if the account name changes) */
  displayName: string;
  /** A name unique to this login — partitions the demo account's workspace per login (session.ts) */
  visitor: string;
}

/** What a role can do — admin and editor modify, viewer views */
export function levelOfRole(role: Principal['role']): AccessLevel {
  return role === 'viewer' ? 'read-only' : 'full';
}

export interface AuthConfig {
  /** Full-access tokens */
  tokens: readonly string[];
  /** Read-only tokens */
  readOnlyTokens: readonly string[];
}

export const OPEN_ACCESS: AuthConfig = { tokens: [], readOnlyTokens: [] };

/** If there are no tokens at all, authentication is off */
export function isOpen(config: AuthConfig): boolean {
  return config.tokens.length === 0 && config.readOnlyTokens.length === 0;
}

/** Compare without leaking timing even when lengths differ */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Different lengths already mean different, but compare anyway to equalize time
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Important: Node reads HTTP headers as latin1 (because RFC 7230 defines header values as ASCII).
 * Whereas `process.env` arrives as UTF-8. So for **tokens containing Korean (non-ASCII) characters** the configured value and the header value
 * become different strings, giving "correct token but 401" — the kind of incident whose cause nobody finds on site.
 * This converts it back to match. Still, tokens are better kept ASCII (intermediate proxies tamper again).
 */
function decodeHeader(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value)) return value; // Pure ASCII — nothing to do
  const restored = Buffer.from(value, 'latin1').toString('utf8');
  return restored.includes('\ufffd') ? value : restored; // If it wasn't UTF-8, use the original
}

/** Extract the token from `Authorization: Bearer <token>`. Query tokens are not accepted (they end up in logs) */
export function tokenOf(request: ApiRequest): string | undefined {
  const header = request.headers['authorization'];
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined ? undefined : decodeHeader(token);
}

/** Whether the token uses ASCII only — if not, report it at startup */
export function isAsciiToken(token: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x21-\x7e]+$/.test(token);
}

/** Whether the request only reads — only GET and HEAD are reads */
export function isReadRequest(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** Paths always left open even with auth on — needing a token just to check liveness would be a problem */
/**
 * Paths passed through without checking tokens or login.
 *
 * Important: **the login door must stay open.** Otherwise it becomes chicken-and-egg — on a server with an API key set,
 *    trying to log in gets blocked by 401 and you can never get in (caught by a test on 2026-10-02).
 *    Why leaving them open is safe: `/auth/login` has an attempt limit, `/auth/setup` works **only when
 *    no account exists**, and `/auth/me` only returns "not logged in" when not logged in.
 */
const ALWAYS_OPEN = new Set([
  '/health',
  '/auth/me',
  '/auth/login',
  '/auth/logout',
  '/auth/setup',
  // Important: someone signing up has no account yet — if this is blocked, nobody can sign up
  '/auth/signup',
]);

/** Whether a path is passed through without tokens or login (the account doors and /health) */
export function isAlwaysOpen(path: string): boolean {
  return ALWAYS_OPEN.has(path);
}

export interface AuthResult {
  ok: boolean;
  level?: AccessLevel;
  /**
   * How it passed — used by the audit record to distinguish "human" from "machine".
   * `open` is a server that does not use authentication at all (installed edition, development).
   */
  via?: 'session' | 'apikey' | 'open';
  /** Response to return when blocked */
  response?: ApiResponse;
}

/**
 * Decide whether to let it through.
 *
 * Important: **the order is the design.** Logged-in people first, tokens after.
 *    Tokens are now **API keys for machines**, not for people (Part 2 REST, registry, scripts).
 *    People move to login, but tokens are kept as-is so existing integrations don't break.
 * Important: with no tokens and no accounts, access is **open**. This is to avoid breaking development, demos and the installed edition,
 *    and the startup log and /health announce it so it is not silently open (same behavior as before).
 */
export function authorize(
  config: AuthConfig,
  request: ApiRequest,
  principal?: Principal,
  /**
   * Whether at least one account exists. Important: if so, even a keyless server is **not opened.**
   * Previously, with no key (AAS_TOKEN), `isOpen` below let requests through even if accounts existed —
   * login was enforced only in the UI, and calling the API directly allowed reading and deleting without login
   * (measured in the 2026-10-06 pre-release review: after creating an admin, DELETE without a cookie -> 204).
   */
  accountsExist = false,
): AuthResult {
  if (ALWAYS_OPEN.has(request.path)) return { ok: true, level: 'full', via: 'open' };

  // 1. Logged-in person
  if (principal) {
    const level = levelOfRole(principal.role);
    if (level === 'full' || isReadRequest(request.method)) return { ok: true, level, via: 'session' };
    return {
      ok: false,
      response: errorResponse(403, 'Forbidden', tr('보기 전용 계정으로는 고칠 수 없습니다.')),
    };
  }

  if (isOpen(config) && !accountsExist) return { ok: true, level: 'full', via: 'open' };

  // 2. Machine API key (former token)
  const token = tokenOf(request);
  if (!token) {
    return {
      ok: false,
      response: errorResponse(
        401,
        'Unauthorized',
        tr('로그인이 필요합니다. 기계라면 Authorization: Bearer <API 키> 헤더를 주십시오.'),
      ),
    };
  }

  if (config.tokens.some((candidate) => sameToken(candidate, token))) {
    return { ok: true, level: 'full', via: 'apikey' };
  }

  if (config.readOnlyTokens.some((candidate) => sameToken(candidate, token))) {
    if (isReadRequest(request.method)) return { ok: true, level: 'read-only', via: 'apikey' };
    return {
      ok: false,
      response: errorResponse(403, 'Forbidden', tr('읽기 전용 토큰으로는 고칠 수 없습니다.')),
    };
  }

  // Not in any list — do not reveal whether it exists
  return { ok: false, response: errorResponse(401, 'Unauthorized', tr('토큰이 올바르지 않습니다.')) };
}

/**
 * Whether a full-access API key is held — used where we ask "is this someone who can touch the server"
 * (first admin creation, security.ts). Unlike authorization, it **does not look at role or path.**
 */
export function fullTokenGiven(config: AuthConfig, request: ApiRequest): boolean {
  const token = tokenOf(request);
  if (!token) return false;
  return config.tokens.some((candidate) => sameToken(candidate, token));
}

/** Read from environment variables. Multiple values are comma-separated */
export function authFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const split = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token !== '');

  return {
    tokens: split(env['AAS_TOKEN']),
    readOnlyTokens: split(env['AAS_READONLY_TOKEN']),
  };
}

/**
 * Decide which address to open on — **protected mode**.
 *
 * Some people will pull from the public repo and run it as-is. The most common incident then is
 * "no token was set, yet it was open to the whole internal network". Only printing a warning at startup
 * does not reach people who don't read logs.
 *
 * So **with no token it opens only on this computer (127.0.0.1)**, and opens externally once a token is set.
 * Redis and Jupyter use the same approach. Development and demos still work (localhost); only unprotected exposure is blocked.
 *
 * If it really must be opened externally without a token, override with `AAS_ALLOW_OPEN=1` —
 * a deliberate extra step so that only those who decide to do so get past it.
 */
export function resolveBindHost(
  env: Record<string, string | undefined>,
  config: AuthConfig,
): { host: string; protected: boolean } {
  const explicit = env['AAS_HOST']?.trim();
  if (explicit) return { host: explicit, protected: false };
  if (!isOpen(config)) return { host: '0.0.0.0', protected: false };
  if (env['AAS_ALLOW_OPEN'] === '1') return { host: '0.0.0.0', protected: false };
  return { host: '127.0.0.1', protected: true };
}
