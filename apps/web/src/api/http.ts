/**
 * API client — request wrapper · errors · access token · download helpers.
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import { tr, fill, currentLang } from '../i18n.js';

/** Part 2 requires ids placed in the path to be base64url-encoded */
export function encodeIdentifier(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Revision mismatch — means it was changed elsewhere first */
export class ConflictError extends ApiError {}

/** Token missing or wrong (401) */
export class UnauthorizedError extends ApiError {}

/** Tried to edit with a read-only token (403) */
export class ForbiddenError extends ApiError {}

/**
 * Access token.
 *
 * When the server has auth enabled it is attached to every request as `Authorization: Bearer`.
 * It is kept in the browser so we do not ask again on every reload —
 * on a shared PC in an air-gapped network, clear it with "Clear token".
 */
const TOKEN_KEY = 'aas.token';
let token: string | undefined = readStoredToken();

function readStoredToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // e.g. private browsing — without storage we simply do without
  }
}

export function setToken(value: string | undefined): void {
  token = value?.trim() || undefined;
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* Even if it cannot be saved, this session still works */
  }
}

export function currentToken(): string | undefined {
  return token;
}

/** Builds headers carrying the token */
/**
 * Two things are sent — the session cookie and (if any) the API key.
 *
 * Important: `credentials: 'same-origin'` is the fetch default but **is spelled out on purpose.** The login session
 *    travels only in the cookie, so if someone unknowingly changes it to 'omit', login breaks entirely and
 *    the cause is hard to find.
 * Important: the UI never touches the session key — it is HttpOnly, so scripts cannot even read it.
 */
export function withAuth(init?: RequestInit): RequestInit {
  // Important: send the selected language to the server — server-generated text (findings · reports · errors) comes back in that language.
  //    Leaving it to the browser default Accept-Language (ko-KR,…,en…) makes the UI setting and server text diverge
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    'accept-language': currentLang(),
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return { ...init, credentials: 'same-origin', headers };
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withAuth(init));
  if (!response.ok) {
    // Turn the spec's Result/Message body into one human-readable line
    let text = `${response.status} ${response.statusText}`;
    let fromApi = false;
    try {
      const body = (await response.json()) as { messages?: { text: string }[] };
      fromApi = true;
      if (body.messages?.[0]?.text) text = body.messages[0].text;
    } catch {
      /* The body may not be JSON */
    }
    // Important: a non-JSON 5xx did not come from the API — it is what sits in front (Vite proxy, reverse proxy) failing to reach the API.
    //    Showing "500 Internal Server Error" verbatim makes people think their file is broken
    if (!fromApi && response.status >= 500) {
      text = tr('API 서버에 연결할 수 없습니다 — 8080이 떠 있는지 확인하십시오 (개발: npm run dev:api).');
    }
    if (response.status === 409) throw new ConflictError(409, text);
    if (response.status === 401) throw new UnauthorizedError(401, text);
    if (response.status === 403) throw new ForbiddenError(403, text);
    throw new ApiError(response.status, text);
  }
  if (response.status === 204) return undefined as T;
  // Important: receiving HTML means the **UI server** answered, not the API (when the dev proxy lacks this path).
  //    Do not show the raw "Unexpected token '<'" to people — tell them where to fix it
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new ApiError(response.status, fill(tr('API 응답이 아닙니다 ({0}) — 개발 서버 프록시(vite.config.ts)에 이 경로가 빠져 있습니다.'), { 0: path }));
  }
  return (await response.json()) as T;
}

export const asJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function toError(response: Response): Promise<ApiError> {
  let text = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { messages?: { text: string }[] };
    if (body.messages?.[0]?.text) text = body.messages[0].text;
  } catch {
    /* The body may not be JSON */
  }
  if (response.status === 401) return new UnauthorizedError(401, text);
  if (response.status === 403) return new ForbiddenError(403, text);
  return new ApiError(response.status, text);
}

/** Check content-disposition filename* (UTF-8) first — that is where Korean filenames live */
export function filenameOf(response: Response): string | undefined {
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="([^"]+)"/i.exec(disposition)?.[1];
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
