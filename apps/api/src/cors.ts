/**
 * CORS — 다른 출처의 **브라우저 앱**이 이 API를 부를 때만 필요하다.
 *
 * 저작 UI는 같은 포트에서 내주고(static.ts) 개발은 Vite 프록시를 지나므로 평소에는 교차 출처
 * 요청이 없다. 서버끼리(MES·BaSyx·스크립트) 부르는 것은 CORS와 무관하다.
 * 그래서 기본은 **헤더를 내지 않는다** — 브라우저가 막는 것이 가장 안전한 상태다.
 *
 * `CORS_ORIGIN`에 허용 출처를 쉼표로 적으면 그 출처에만 응답한다(`*`는 전부).
 * 토큰 인증과 같이 쓰므로 자격증명(credentials)은 허용하지 않는다 — Authorization 헤더로 충분하다.
 */
const ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'authorization, content-type, if-match, if-none-match';
const EXPOSE_HEADERS = 'etag, location, content-disposition';

export interface CorsPolicy {
  /** 허용 출처. 비어 있으면 CORS 헤더를 내지 않는다 */
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
 * 이 요청의 Origin에 붙일 CORS 헤더. 허용되지 않으면 빈 객체 — 브라우저가 알아서 막는다.
 * 출처 비교는 대소문자 무시(스킴·호스트는 대소문자 구분이 없다)·끝 슬래시 무시.
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
    // 출처별로 응답이 달라지니 캐시가 섞이지 않게 — `*`일 때도 해롭지 않다
    vary: 'Origin',
  };
}

/** 사전 요청(preflight)인가 — OPTIONS + Access-Control-Request-Method */
export function isPreflight(method: string, headers: Record<string, string | string[] | undefined>): boolean {
  return method === 'OPTIONS' && headers['access-control-request-method'] !== undefined;
}
