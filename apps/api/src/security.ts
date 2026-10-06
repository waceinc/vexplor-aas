/**
 * 보안 머리글과 CSRF 원점 검사 — 로그인을 들이면서 함께 필요해진 것들(계획 A8).
 *
 * 토큰만 쓰던 때는 브라우저가 자격을 **자동으로** 싣지 않았다. 쿠키 세션은 다르다 —
 * 브라우저가 알아서 싣기 때문에, 남의 사이트가 우리 서버로 요청을 보내게 만들면
 * 그 요청에 우리 쿠키가 따라붙는다(CSRF). 그래서 두 겹으로 막는다.
 *
 *   ① `SameSite=Strict` 쿠키 — 다른 사이트에서 온 요청에는 쿠키가 아예 안 실린다(routes/auth.ts)
 *   ② 여기의 원점 검사 — ①이 듣지 않는 경우(옛 브라우저, 같은 사이트 안의 다른 앱)를 위한 덧문
 *
 * 🔴 **①만으로 됐다고 보지 않는 이유**: SameSite는 브라우저가 지켜 주는 약속이고,
 *    「같은 사이트」는 등록 가능 도메인 단위라 `a.example.com`이 `b.example.com`을
 *    부르는 것은 같은 사이트로 친다. 사내망에 호스트가 여럿인 흔한 구성이다.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { errorResponse, type ApiRequest, type ApiResponse } from './http.js';

/** 상태를 바꾸는 메서드 — 이들만 원점을 따진다 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 모든 응답에 붙는 머리글.
 *
 * 🔴 `https`가 참일 때만 HSTS를 붙인다. 평문으로 받는 서버가 HSTS를 말하면
 *    그 호스트는 브라우저에서 **HTTPS로만** 열리게 굳어 버린다 — 사내망 http 주소를
 *    쓰던 사람들이 한꺼번에 못 들어온다. 되돌리려면 각자 브라우저를 손봐야 한다.
 */
export function securityHeaders(https: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    // 선언한 것과 다른 종류로 해석하지 못하게 — 업로드한 파일이 스크립트로 실행되는 길을 끊는다
    'x-content-type-options': 'nosniff',
    // 주소에 패키지 id·식별자가 들어가므로 바깥으로 흘리지 않는다
    'referrer-policy': 'no-referrer',
    // CSP의 frame-ancestors를 모르는 옛 브라우저용 — 같은 뜻을 두 번 말한다
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // 남의 페이지에 우리 화면을 끼워 넣고 클릭을 가로채는 것(clickjacking)을 막는다
      "frame-ancestors 'none'",
      "form-action 'self'",
      // blob: — 다이어그램 SVG를 캔버스로 PNG로 바꿀 때 쓴다(DocAssets.tsx)
      "img-src 'self' data: blob:",
      // 🔴 'unsafe-inline'이 style에만 붙는다. React가 style 속성을 직접 박기 때문에
      //    빼면 화면이 깨진다. script에는 붙이지 않는다 — 그쪽이 실제 위험이다
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

/** 프록시 뒤에서도 「이 요청이 HTTPS로 왔나」를 본다 */
export function isHttps(headers: Record<string, string | string[] | undefined>, encrypted: boolean): boolean {
  if (encrypted) return true;
  // 🔴 리버스 프록시(Caddy·nginx)가 붙여 주는 값이다. **프록시 뒤에서만 믿을 수 있다** —
  //    서버를 바로 노출하면 아무나 보낼 수 있는 머리글이다. 그래서 이것으로 여는 문은 없고,
  //    HSTS를 붙일지만 정한다(붙여서 손해 보는 쪽은 공격자가 아니라 우리다)
  const forwarded = headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? '').split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * 이 요청이 **남의 사이트에서 온 것**인가.
 *
 * 쿠키로 들어온 상태 변경만 따진다:
 *  - API 키(Authorization 헤더)는 남의 사이트가 붙일 수 없다 — 붙이려면 CORS 사전요청을
 *    통과해야 하고, 우리는 자격증명 CORS를 허용하지 않는다(cors.ts)
 *  - 읽기(GET·HEAD)는 바꾸는 것이 없다
 *
 * `Origin`이 아예 없으면 통과시킨다. 브라우저가 아닌 것(curl·스크립트·서버)이고,
 * 그런 호출자는 애초에 남의 쿠키를 들고 있지 않다.
 */
export function crossSiteWrite(
  request: ApiRequest,
  allowedOrigins: readonly string[],
): ApiResponse | undefined {
  if (!MUTATING.has(request.method)) return undefined;
  const origin = request.headers['origin'];
  if (!origin || origin === 'null') return undefined;

  // 🔴 프록시 뒤에서는 `Host`가 바뀌어 있을 수 있다. Caddy는 원래 값을 그대로 넘기지만
  //    nginx는 기본값이 **업스트림 주소**(127.0.0.1:8080)라, 그대로 비교하면 로그인한
  //    사람의 **모든 쓰기가 403**이 된다. 프록시가 알려 주는 원래 호스트를 먼저 본다.
  //    이 머리글을 믿어도 되는 이유: 속여도 「자기 자신에서 온 것처럼」 보일 뿐이고,
  //    남의 사이트는 Origin을 못 고른다 — 브라우저가 정해서 보낸다.
  for (const host of [request.headers['x-forwarded-host'], request.headers['host']]) {
    if (host !== undefined && host !== '' && sameOrigin(origin, host)) return undefined;
  }
  if (allowedOrigins.includes('*')) return undefined;
  if (allowedOrigins.some((allowed) => normalize(allowed) === normalize(origin))) return undefined;

  return errorResponse(
    403,
    'Forbidden',
    '다른 사이트에서 보낸 요청은 받지 않습니다. 브라우저 주소창의 주소로 직접 접속하십시오.',
  );
}

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Origin의 host:port가 Host와 같은가 — 스킴은 프록시가 바꿀 수 있어 보지 않는다.
 * `X-Forwarded-Host`는 프록시가 여럿이면 쉼표로 이어 붙으므로 맨 앞(원래 접속)을 쓴다.
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
 * 첫 관리자 만들기를 아무나 선점하지 못하게 하는 **설치 코드**.
 *
 * 🔴 왜 필요한가(2026-10-02에 발견). `/auth/setup`은 계정이 하나도 없을 때 누구나 부를 수
 *    있어야 한다 — 그래야 첫 관리자를 만든다. 그런데 서버가 밖으로 열려 있으면
 *    **같은 망의 아무나 먼저 불러 관리자가 되고**, 정작 운영자는 409로 막힌다.
 *    `.env.example`이 권하던 구성(AAS_ALLOW_OPEN=1 · 토큰 없음)이 바로 그 상태였다.
 *
 * 막는 방법은 「서버를 만질 수 있는 사람인가」를 묻는 것이다. 셋 중 하나면 통과한다:
 *   ① **이 컴퓨터에서만** 열린 서버(보호 모드) — 서버 앞에 앉아 있는 사람이다
 *   ② 올바른 API 키 — 운영자가 이미 들고 있는 비밀이다
 *   ③ 기동 로그에 찍힌 **설치 코드** — 로그를 볼 수 있다는 것은 서버를 만질 수 있다는 뜻이다
 *
 * 코드는 프로세스마다 한 번 만든다(서버를 다시 띄우면 바뀐다). `AAS_SETUP_CODE`로
 * 직접 정할 수도 있다 — 컨테이너 로그를 보기 어려운 배포를 위해서다.
 */
let processCode: string | undefined;

export function setupCode(env: Record<string, string | undefined>): string {
  const explicit = env['AAS_SETUP_CODE']?.trim();
  if (explicit) return explicit;
  processCode ??= randomBytes(6).toString('hex');
  return processCode;
}

/** 설치 코드를 물어야 하는가 — 이 컴퓨터에서만 열린 서버는 묻지 않는다 */
export function setupCodeRequired(protectedBind: boolean): boolean {
  return !protectedBind;
}

/** 길이가 달라도 시간 차로 새지 않게 비교한다 */
export function sameCode(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) {
    // 길이가 다르면 어차피 틀렸다. 그래도 같은 시간을 쓰도록 자기 자신과 한 번 비교한다
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 요청이 들어온 곳 — 가입 속도 제한이 쓴다.
 *
 * 🔴 `X-Forwarded-For`는 **속일 수 있다.** 그래서 이것으로 여는 문은 없고, 세는 데만 쓴다.
 *    속이면 주소별 상한을 피할 수 있지만 전체 상한은 못 피한다(session.ts SignupThrottle).
 */
export function clientAddress(request: ApiRequest): string | undefined {
  // 🔴 **마지막** 칸을 쓴다(2026-10-06 보안 점검). 앞 칸은 손님이 적어 보낸 것일 수 있고,
  //    프록시(Caddy · Cloudflare)는 자기가 본 주소를 **뒤에 덧붙인다.** 첫 칸을 쓰면
  //    헤더 하나로 주소를 바꿔 가며 시도 제한을 피할 수 있었다.
  //    (이 서버는 프록시 뒤에서만 띄운다 — 앱 포트는 127.0.0.1에만 묶는다)
  const forwarded = request.headers['x-forwarded-for'];
  const last = forwarded?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return last || request.remoteAddress;
}
