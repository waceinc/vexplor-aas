/**
 * 접근 제어 — 토큰 방식.
 *
 * 폐쇄망 공장 서버가 주 배포처다(기획서 Ⅷ). 그래서 계정·세션 관리를 들이지 않고
 * **미리 나눠 준 토큰**만 확인한다. 의존성이 늘지 않고(라이선스 검토도 늘지 않는다),
 * 무엇이 통과하고 무엇이 막히는지 한 파일에서 다 읽힌다.
 *
 * 세 가지를 정했다.
 *  ① 토큰을 설정하지 않으면 열려 있다 — 개발과 시연을 깨뜨리지 않기 위해서다.
 *     다만 **조용히 열려 있으면 안 되므로** 서버가 시작할 때 경고하고 `/health`에도 표시한다
 *  ② 읽기 전용 토큰을 따로 둘 수 있다. 검수자에게는 편집 권한을 줄 이유가 없다
 *  ③ 토큰 비교는 **시간이 일정하게** 한다. 문자열 비교는 앞자리부터 틀리는 지점이 빨라
 *     응답 시간으로 토큰을 한 글자씩 알아낼 수 있다
 */
import { timingSafeEqual } from 'node:crypto';
import { errorResponse, type ApiRequest, type ApiResponse } from './http.js';

export type AccessLevel = 'full' | 'read-only';

/**
 * 로그인한 사람 — 세션에서 풀어낸 것.
 * 🔴 여기까지 왔다는 것은 **이미 세션이 살아 있다는 뜻**이다. auth.ts는 다시 확인하지 않는다.
 */
export interface Principal {
  userId: string;
  /** 로그인 이름 — 체험 계정인지 가르는 데 쓴다(demo.ts) */
  login: string;
  role: 'admin' | 'editor' | 'viewer';
  /** 그때의 표시 이름 — 감사 기록에 그대로 베껴 넣는다(계정 이름이 바뀌어도 과거는 안 바뀐다) */
  displayName: string;
  /** 이 로그인만의 이름 — 체험 계정의 작업 공간을 로그인마다 가른다(session.ts) */
  visitor: string;
}

/** 역할이 무엇을 할 수 있나 — admin·editor는 고치고, viewer는 본다 */
export function levelOfRole(role: Principal['role']): AccessLevel {
  return role === 'viewer' ? 'read-only' : 'full';
}

export interface AuthConfig {
  /** 전체 권한 토큰들 */
  tokens: readonly string[];
  /** 읽기 전용 토큰들 */
  readOnlyTokens: readonly string[];
}

export const OPEN_ACCESS: AuthConfig = { tokens: [], readOnlyTokens: [] };

/** 토큰이 하나도 없으면 인증이 꺼진 것이다 */
export function isOpen(config: AuthConfig): boolean {
  return config.tokens.length === 0 && config.readOnlyTokens.length === 0;
}

/** 길이가 달라도 시간이 새지 않게 비교한다 */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // 길이가 다르면 그 자체로 다르지만, 비교는 해서 시간을 맞춘다
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * 🔴 Node는 HTTP 헤더를 latin1로 읽는다(RFC 7230이 헤더 값을 ASCII로 정하기 때문이다).
 * 반면 `process.env`는 UTF-8로 온다. 그래서 **한글이 섞인 토큰**은 설정값과 헤더값이
 * 서로 다른 문자열이 되어 "맞는 토큰인데 401"이 난다 — 현장에서 원인을 못 찾을 종류의 사고다.
 * 여기서 되돌려 맞춰 준다. 다만 토큰은 ASCII로 정하는 편이 낫다(중간 프록시가 또 건드린다).
 */
function decodeHeader(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value)) return value; // 순수 ASCII — 손댈 것 없다
  const restored = Buffer.from(value, 'latin1').toString('utf8');
  return restored.includes('\ufffd') ? value : restored; // UTF-8이 아니었으면 원본을 쓴다
}

/** `Authorization: Bearer <토큰>` 에서 토큰을 꺼낸다. 쿼리 토큰은 받지 않는다(로그에 남는다) */
export function tokenOf(request: ApiRequest): string | undefined {
  const header = request.headers['authorization'];
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined ? undefined : decodeHeader(token);
}

/** ASCII만 쓰는 토큰인지 — 아니면 기동할 때 알려 준다 */
export function isAsciiToken(token: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x21-\x7e]+$/.test(token);
}

/** 읽기만 하는 요청인지 — GET·HEAD만 읽기다 */
export function isReadRequest(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** 인증이 켜져 있어도 항상 열어 두는 경로 — 살아 있는지 보는 데 토큰이 필요하면 곤란하다 */
/**
 * 토큰·로그인을 따지지 않고 통과시키는 경로.
 *
 * 🔴 **로그인 문은 열려 있어야 한다.** 안 그러면 닭과 달걀이 된다 — API 키를 설정한 서버에서는
 *    로그인을 하려 해도 401에 막혀 영영 못 들어간다(2026-10-02 테스트가 잡았다).
 *    열어 둬도 안전한 이유: `/auth/login`은 시도 제한이 있고, `/auth/setup`은 **계정이 하나도
 *    없을 때만** 동작하며, `/auth/me`는 로그인 안 했으면 "안 했다"만 돌려준다.
 */
const ALWAYS_OPEN = new Set([
  '/health',
  '/auth/me',
  '/auth/login',
  '/auth/logout',
  '/auth/setup',
  // 🔴 가입하려면 아직 계정이 없다 — 여기가 막히면 아무도 가입할 수 없다
  '/auth/signup',
]);

export interface AuthResult {
  ok: boolean;
  level?: AccessLevel;
  /**
   * 무엇으로 통과했나 — 감사 기록이 「사람」과 「기계」를 구분하려고 쓴다.
   * `open`은 인증을 아예 안 쓰는 서버(설치판·개발)다.
   */
  via?: 'session' | 'apikey' | 'open';
  /** 막혔을 때 돌려줄 응답 */
  response?: ApiResponse;
}

/**
 * 통과시킬지 정한다.
 *
 * 🔴 **순서가 설계다.** 로그인한 사람이 먼저고 토큰이 나중이다.
 *    토큰은 이제 사람이 아니라 **기계용 API 키**다(Part 2 REST·레지스트리·스크립트).
 *    사람은 로그인으로 옮기되 토큰은 그대로 둬서 기존 연동이 깨지지 않는다.
 * 🔴 토큰이 하나도 없고 계정도 없으면 **열려 있다**. 개발·시연·설치판을 깨뜨리지 않기
 *    위해서이며, 조용히 열리지 않도록 기동 로그와 /health가 알린다(기존 성질 그대로).
 */
export function authorize(
  config: AuthConfig,
  request: ApiRequest,
  principal?: Principal,
  /**
   * 계정이 하나라도 있는가. 🔴 있으면 키 없는 서버라도 **열어 주지 않는다.**
   * 예전에는 키(AAS_TOKEN)가 없으면 계정이 있어도 아래 `isOpen`에서 통과시켰다 —
   * 로그인은 화면에만 걸려 있고, API를 직접 부르면 로그인 없이 읽고 지울 수 있었다
   * (2026-10-06 출시 전 검토에서 실측: 관리자를 만든 뒤 쿠키 없이 DELETE → 204).
   */
  accountsExist = false,
): AuthResult {
  if (ALWAYS_OPEN.has(request.path)) return { ok: true, level: 'full', via: 'open' };

  // ① 로그인한 사람
  if (principal) {
    const level = levelOfRole(principal.role);
    if (level === 'full' || isReadRequest(request.method)) return { ok: true, level, via: 'session' };
    return {
      ok: false,
      response: errorResponse(403, 'Forbidden', '보기 전용 계정으로는 고칠 수 없습니다.'),
    };
  }

  if (isOpen(config) && !accountsExist) return { ok: true, level: 'full', via: 'open' };

  // ② 기계용 API 키(옛 토큰)
  const token = tokenOf(request);
  if (!token) {
    return {
      ok: false,
      response: errorResponse(
        401,
        'Unauthorized',
        '로그인이 필요합니다. 기계라면 Authorization: Bearer <API 키> 헤더를 주십시오.',
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
      response: errorResponse(403, 'Forbidden', '읽기 전용 토큰으로는 고칠 수 없습니다.'),
    };
  }

  // 어느 목록에도 없다 — 있는지 없는지 알려 주지 않는다
  return { ok: false, response: errorResponse(401, 'Unauthorized', '토큰이 올바르지 않습니다.') };
}

/**
 * 전체 권한 API 키를 들고 있는가 — 「서버를 만질 수 있는 사람인가」를 묻는 자리가 쓴다
 * (첫 관리자 만들기, security.ts). 인가 판단과 달리 **역할·경로를 보지 않는다.**
 */
export function fullTokenGiven(config: AuthConfig, request: ApiRequest): boolean {
  const token = tokenOf(request);
  if (!token) return false;
  return config.tokens.some((candidate) => sameToken(candidate, token));
}

/** 환경변수에서 읽는다. 쉼표로 여러 개를 준다 */
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
 * 어느 주소에 문을 열지 정한다 — **보호 모드**.
 *
 * 공개 저장소에서 받아 그대로 띄우는 사람이 생긴다. 그때 가장 흔한 사고가
 * "토큰을 안 넣었는데 사내망 전체에 열려 있었다"이다. 시작할 때 경고만 찍어서는
 * 로그를 안 보는 사람에게 닿지 않는다.
 *
 * 그래서 **토큰이 없으면 이 컴퓨터에서만(127.0.0.1) 열고**, 토큰을 넣으면 그때 밖으로 연다.
 * Redis·Jupyter가 같은 방식을 쓴다. 개발·시연은 그대로 되고(localhost), 무방비 노출만 막힌다.
 *
 * 굳이 토큰 없이 밖으로 열어야 하면 `AAS_ALLOW_OPEN=1`로 뚫는다 —
 * 스스로 정한 사람만 넘어가도록 한 단계를 둔 것이다.
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
