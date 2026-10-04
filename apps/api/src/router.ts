/**
 * 아주 작은 경로 라우터.
 *
 * 프레임워크를 들이지 않은 이유는 Part 2의 경로가 단순하고(정적 세그먼트 + 식별자),
 * 의존성 하나가 늘 때마다 라이선스 검토가 따라붙기 때문이다(기획서 Ⅲ-2 라이선스 항목).
 */
import type { ApiRequest, ApiResponse } from './http.js';

export interface RouteContext {
  request: ApiRequest;
  params: Record<string, string>;
}

export interface Route {
  method: string;
  /** `/packages/:packageId/api/v3.0/submodels/:id` 형태. `:name`은 한 세그먼트를 잡는다 */
  pattern: string;
  /**
   * 규격이 정한 성공 상태코드. 규격 대조(scripts/part2-coverage.mjs)가 이 값을 원문과 맞대어 본다.
   * 규격 밖 확장 경로는 비워 둔다.
   */
  success?: number[];
  handle: (ctx: RouteContext) => Promise<ApiResponse>;
}

interface Compiled extends Route {
  segments: string[];
  /** 매개변수 개수. 적을수록(=고정 세그먼트가 많을수록) 더 구체적인 경로다 */
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
 * 경로를 찾는다.
 *
 * 여러 개가 맞으면 **고정 세그먼트가 많은 쪽**이 이긴다.
 * `/submodels/$reference`(고정)와 `/submodels/{id}`(매개변수)는 둘 다 맞는데, 등록 순서에 맡기면
 * 수식자 경로가 식별자로 먹혀 base64url 해석에서 엉뚱하게 실패한다.
 * 경로만 맞고 메서드가 다른 경우는 405로 구분한다.
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
