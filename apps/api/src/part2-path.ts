/**
 * Part 2 base path of each version (2026-10-19).
 *
 * The V3.0 OpenAPI serves under `/api/v3.0`; the V3.1 and V3.2 OpenAPI files moved it to `/api/v3/`
 * (servers: `https://admin-shell.io/api/v3/`). A 3.1 / 3.2 client therefore calls `/api/v3/shells` where this server
 * has always answered `/api/v3.0/shells`. Both spellings reach the same routes — the V3.0 path stays exactly as it was.
 *
 * Important: only the spelling is aliased. The endpoints that are new in V3.2 (`$recent-changes`, `$history`,
 *    `$signed`, the asynchronous package operations) do not exist here; under either prefix they answer 404 like any
 *    unknown path (docs/usage.md §12-2).
 */
import type { ApiRequest } from './http.js';

/** `/api/v3/…` → `/api/v3.0/…`, also under `/packages/{packageId}`. Anything else — `/api/v3.0` included — is unchanged */
export function canonicalPart2Path(path: string): string {
  return path.replace(/^((?:\/packages\/[^/]+)?\/api\/v3)(?=\/|$)/, '$1.0');
}

export function withCanonicalPart2Path(request: ApiRequest): ApiRequest {
  const path = canonicalPart2Path(request.path);
  return path === request.path ? request : { ...request, path };
}
