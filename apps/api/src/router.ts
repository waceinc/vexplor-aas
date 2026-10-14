/**
 * A very small path router.
 *
 * Why no framework: Part 2 paths are simple (static segments + identifiers),
 * and every added dependency brings a license review with it (plan Ⅲ-2 license item).
 */
import type { ApiRequest, ApiResponse } from './http.js';

export interface RouteContext {
  request: ApiRequest;
  params: Record<string, string>;
}

export interface Route {
  method: string;
  /** Of the form `/packages/:packageId/api/v3.0/submodels/:id`. `:name` captures one segment */
  pattern: string;
  /**
   * Success status code defined by the spec. The spec check (scripts/part2-coverage.mjs) compares this value against the original text.
   * Left empty for extension routes outside the spec.
   */
  success?: number[];
  handle: (ctx: RouteContext) => Promise<ApiResponse>;
}

interface Compiled extends Route {
  segments: string[];
  /** Number of parameters. Fewer (= more fixed segments) means a more specific route */
  params: number;
}

export function compile(routes: readonly Route[]): Compiled[] {
  return routes.map((route) => {
    const segments = split(route.pattern);
    return { ...route, segments, params: segments.filter((s) => s.startsWith(':')).length };
  });
}

function split(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

export interface MatchResult {
  route: Compiled;
  params: Record<string, string>;
}

/**
 * Find a route.
 *
 * When several match, the one with **more fixed segments** wins.
 * `/submodels/$reference` (fixed) and `/submodels/{id}` (parameter) both match; leaving it to registration order would
 * let the modifier path be swallowed as an identifier and fail oddly in base64url decoding.
 * A path match with a different method is distinguished as 405.
 */
export function match(
  routes: readonly Compiled[],
  method: string,
  path: string,
): MatchResult | 'method-not-allowed' | undefined {
  const parts = split(path).map((s) => decodeURIComponent(s));
  let pathMatched = false;
  let best: MatchResult | undefined;

  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i]!;
      const value = parts[i]!;
      if (segment.startsWith(':')) params[segment.slice(1)] = value;
      else if (segment !== value) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    if (!best || route.params < best.route.params) best = { route, params };
  }

  if (best) return best;
  return pathMatched ? 'method-not-allowed' : undefined;
}
