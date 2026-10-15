/**
 * Request/response shapes not tied to the transport layer.
 *
 * Keeping handlers detached from node:http lets tests run as plain function calls without sockets.
 * The real server is handled by a thin adapter in server.ts.
 */

export interface ApiRequest {
  method: string;
  /** Path with the query string removed */
  path: string;
  query: Record<string, string>;
  /**
   * Query parameters that appear multiple times. Some places in the spec use the `?aasIds=..&aasIds=..` form
   * (serialization). If absent, the single value in query is used.
   */
  queryAll?: Record<string, string[]>;
  /** The parsed value if JSON, bytes if a file upload */
  body?: unknown;
  headers: Record<string, string>;
  /**
   * The logged-in user — the API decodes the session and **attaches it to the request** before routing (2026-10-02).
   *
   * Important: this keeps routes from decoding the session again themselves. Decoding in two places means only one gets fixed,
   *    ending up as "admin in the UI, but this one API refuses". The only place it is decoded is api.ts.
   * Important: may be absent — the request came in with a token (API key) or the server has auth disabled.
   */
  principal?: {
    userId: string;
    login: string;
    role: 'admin' | 'editor' | 'viewer';
    displayName: string;
    visitor: string;
  };
  /**
   * Address of the connecting peer. Filled in by the transport layer (server.ts).
   * Important: **use it only for counting** — behind a proxy it is not a trustworthy value (security.ts).
   */
  remoteAddress?: string;
  /**
   * How this request was let in — set by api.ts next to `principal`, from the same single authorization decision.
   * Important: "no principal" alone does not tell a full API key from a read-only one. Routes that need an admin read
   *    this instead of assuming (red-team M2, 2026-10-16: a read-only key passed the admin check and read contact details).
   */
  access?: { level: 'full' | 'read-only'; via: 'session' | 'apikey' | 'open' };
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** A JSON-serializable value or bytes sent out as-is */
  body?: unknown;
}

export type Handler = (request: ApiRequest) => Promise<ApiResponse>;

export const JSON_TYPE = 'application/json';

export function json(status: number, body: unknown): ApiResponse {
  return { status, headers: { 'content-type': JSON_TYPE }, body };
}

export function noContent(): ApiResponse {
  return { status: 204, headers: {} };
}

export function bytes(status: number, data: Uint8Array, contentType: string, filename?: string): ApiResponse {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (filename) {
    // Non-ASCII (e.g. Korean) file names are folded to ASCII and the UTF-8 original is also given in filename* (plan Ⅷ encoding item)
    headers['content-disposition'] =
      `attachment; filename="download.aasx"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  return { status, headers, body: data };
}

/** IDTA Part 2 Result/Message error body */
export interface Message {
  code: string;
  messageType: 'Error' | 'Warning' | 'Info';
  text: string;
  timestamp: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The server is busy with expensive work (password hashes, large uploads) — 503 with `Retry-After`.
 * Important: a refusal, not a queue without end. Queuing everything turns a burst into memory and minutes of latency
 *    for everyone; refusing early keeps the server answering (red-team L4 / L9, 2026-10-16).
 */
export class ServiceBusyError extends ApiError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(503, 'ServiceUnavailable', message);
    this.name = 'ServiceBusyError';
  }
}

export function errorResponse(status: number, code: string, text: string): ApiResponse {
  const message: Message = {
    code,
    messageType: 'Error',
    text,
    timestamp: new Date().toISOString(),
  };
  return json(status, { messages: [message] });
}

/** Part 2 paged response envelope */
export function pagedResponse<T>(items: T[], cursor?: string): ApiResponse {
  return json(200, {
    paging_metadata: cursor === undefined ? {} : { cursor },
    result: items,
  });
}
