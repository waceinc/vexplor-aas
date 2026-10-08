/**
 * API 조립 — 라우팅과 오류 변환.
 *
 * 저장소 오류(NotFound·Conflict·InvalidContent)를 HTTP 상태로 옮기는 곳이 여기 한 곳뿐이도록
 * 모아 뒀다. 핸들러는 도메인 오류를 그냥 던지면 된다.
 */
import { PRODUCT_VERSION } from '@aas/core';
import {
  ConflictError,
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  runAsActor,
  runInWorkspace,
  scopeStore,
  type AasStore,
  type Actor,
  type Workspace,
} from '@aas/store';
import { AasxLimitError, AasxReadError, type AasxLimits } from '@aas/aasx';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import type { LinterPolicy } from '@aas/linter';
import { ValueNotSupportedError } from './elements.js';
import { ApiError, errorResponse, json, type ApiRequest, type ApiResponse } from './http.js';
import { authorize, fullTokenGiven, isOpen, OPEN_ACCESS, type AuthConfig, type AuthResult, type Principal } from './auth.js';
import { buildAuthRoutes, principalOf } from './routes/auth.js';
import { LoginThrottle, SessionStore, SignupThrottle } from './session.js';
import { crossSiteWrite, isHttps } from './security.js';
import { isFileDownload, VISITOR_PREFIX, type DemoConfig } from './demo.js';
import { compile, match, type Route } from './router.js';
import { registryRoutes } from './routes/registry.js';
import { packageRoutes, type PackageRouteOptions } from './routes/packages.js';
import { bundleRoutes } from './routes/bundle.js';
import { AASX_FILE_SERVER_PROFILES, descriptionRoute, part2Routes } from './routes/part2.js';
import { describeChange, UndoStack } from './undo.js';

export interface ApiOptions {
  /** 추가 경로 — 시험용 확장 지점 */
  routes?: Route[];
  /** 업로드 AASX 압축 해제 상한(기획서 Ⅷ). 지정하지 않으면 @aas/aasx의 기본값 */
  aasxLimits?: Partial<AasxLimits>;
  /** 수집 어댑터(M8). 없으면 수집 경로가 501로 답한다 */
  openReader?: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /**
   * 설비 훑기 — 붙어서 태그 목록을 가져온다. 없으면 501.
   * 🔴 프로토콜을 아는 것은 @aas/opcua 하나뿐이라 여기서도 주입받는다(openReader와 같은 원칙).
   */
  browseDevice?: (endpoint: string) => Promise<unknown>;
  /** 내장 가상 PLC(시뮬레이션). 없으면 「가상 PLC로 연결」이 501 */
  simulate?: PackageRouteOptions['simulate'];
  /** 서버 기본 린터 정책(규정 충돌 선택). 질의 인자가 오면 그것이 우선한다 */
  policy?: Partial<LinterPolicy>;
  /**
   * 허용한 교차 출처(CORS_ORIGIN). 쿠키 세션으로 들어온 **쓰기**의 원점 검사에 쓴다 —
   * 여기 없는 사이트에서 온 변경은 거절한다(security.ts). 비우면 같은 출처만 쓴다.
   */
  corsOrigins?: readonly string[];
  /**
   * 첫 관리자 만들기에 물을 설치 코드. 밖으로 열린 서버에서만 준다 —
   * 이 컴퓨터에서만 열린 서버(보호 모드)는 묻지 않는다(security.ts).
   */
  setupCode?: string;
  /**
   * 체험판 설정(`DEMO_MODE=on`). 주면 **데모 계정으로는 파일을 내려받지 못한다** —
   * 가입해 자기 계정으로 들어오면 받을 수 있다. 주지 않으면 아무 제한이 없다(demo.ts).
   */
  demo?: DemoConfig;
  /**
   * 스스로 가입하기(`AAS_SIGNUP=on`). 주지 않으면 가입 경로가 403.
   * `privacyUrl`이 없으면 **연락처를 받지 않는다**(개인정보처리방침 선행 강제).
   */
  signup?: { role: 'admin' | 'editor' | 'viewer'; privacyUrl?: string };
  /**
   * 작업 공간을 사람마다 나눌지(`AAS_WORKSPACE=private`, 체험판이면 자동).
   *
   * 기본은 **나누지 않는다** — 팀이 같은 파일을 같이 보는 것이 이 도구의 기본 쓰임새다.
   * 나누면 저마다 자기가 올린 것만 보고, 남의 것은 없는 것처럼 보인다(@aas/store scoped.ts).
   */
  privateWorkspaces?: boolean;
  /**
   * 나누는 서버에서 한 사람이 가질 수 있는 파일 수(기본 50). 0이면 무제한.
   * 🔴 공개 서버에서 디스크를 채우는 것을 막는다 — 체험 방문자는 60분 정리가 있지만 가입한 사람은 없다
   */
  maxPackagesPerOwner?: number;
  /** 가입 속도 제한. 🔴 시험이 시각을 쥐려면 밖에서 넣는다 */
  signupThrottle?: SignupThrottle;
  /** 접근 제어(기계용 API 키). 주지 않으면 열려 있다(개발·시연용) */
  auth?: AuthConfig;
  /**
   * 로그인 세션 — 주지 않으면 이 API가 자기 것을 만든다.
   * 🔴 테스트가 시각을 쥐려면 밖에서 넣는다.
   */
  sessions?: SessionStore;
  /** HTTPS 뒤에 있나 — Secure 쿠키를 붙일지. 평문 HTTP에서 켜면 로그인이 아예 안 된다 */
  secureCookie?: (request: ApiRequest) => boolean;
  /**
   * 밖에서 이 서버를 부르는 주소(레지스트리가 알려 줄 주소).
   * 🔴 리버스 프록시 뒤에 두면 반드시 준다 — 틀린 주소를 알려 주면 아무도 못 찾아온다.
   * 환경변수 `AAS_PUBLIC_URL`로도 준다.
   */
  publicBaseUrl?: string;
  /** 되돌리기 스택. createApi가 만들어 넘긴다 — 라우트 표를 대조할 때는 없어도 된다 */
  undo?: UndoStack;
}

/**
 * 전체 라우트 표.
 *
 * 밖으로 내보내는 이유는 규격 대조 때문이다 — scripts/part2-coverage.mjs가 이 표를
 * IDTA Part 2 원문(docs/spec/part2/)과 맞대어 본다. 라우트를 늘리거나 지우면 그 대조가 따라 움직인다.
 */
export function buildRoutes(store: AasStore, options: ApiOptions = {}): Route[] {
  return [
    ...buildAuthRoutes(store, {
      sessions: options.sessions ?? new SessionStore(),
      throttle: new LoginThrottle(),
      // 프록시가 붙여 주는 X-Forwarded-Proto를 본다. 평문으로 들어온 사람에게
      // Secure를 붙이면 브라우저가 쿠키를 버려 로그인이 아예 안 된다
      secureCookie: options.secureCookie ?? ((request) => isHttps(request.headers, false)),
      tokenAuth: !isOpen(options.auth ?? OPEN_ACCESS),
      ...(options.setupCode === undefined ? {} : { setupCode: options.setupCode }),
      ...(options.signup ? { signup: options.signup } : {}),
      ...(options.signupThrottle ? { signupThrottle: options.signupThrottle } : {}),
      ...(options.demo ? { demo: { login: options.demo.login, password: options.demo.password } } : {}),
      hasFullKey: (request) => fullTokenGiven(options.auth ?? OPEN_ACCESS, request),
    }),
    ...packageRoutes(store, {
      ...(options.aasxLimits ? { aasxLimits: options.aasxLimits } : {}),
      ...(options.openReader ? { openReader: options.openReader } : {}),
      ...(options.browseDevice ? { browseDevice: options.browseDevice } : {}),
      ...(options.simulate ? { simulate: options.simulate } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    }),
    ...bundleRoutes(store, {
      ...(options.aasxLimits ? { aasxLimits: options.aasxLimits } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    }),
    // 루트는 AASX 파일 서버 인터페이스의 기저 주소다
    descriptionRoute('/description', AASX_FILE_SERVER_PROFILES),
    ...part2Routes(store),
    // 레지스트리·디스커버리 — 서버 단위(파일 하나가 아니라 이 서버가 가진 전부)
    ...registryRoutes(store, options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    ...(options.routes ?? []),
    ...undoRoutes(options.undo ?? new UndoStack(store)),
    {
      method: 'GET',
      pattern: '/health',
      // 인증이 꺼져 있다는 사실을 숨기지 않는다 — 운영에 올린 뒤 확인하는 자리다
      // 판 번호를 함께 준다 — 배포처가 여럿이면 "어느 판인가"가 문의의 첫 질문이다
      handle: async () =>
        json(200, {
          status: 'ok',
          version: PRODUCT_VERSION,
          // 🔴 키가 없어도 계정이 있으면 로그인을 요구한다 — 「off」라고 하면 운영자도 공격자도 오해한다
          auth: isOpen(options.auth ?? OPEN_ACCESS) && (await store.countUsers()) === 0 ? 'off' : 'on',
        }),
    },
  ];
}

/** 모델을 바꿀 수 있는 요청인가 — 되돌리기 스냅샷을 찍을지 정한다 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UNDO_PATTERNS = new Set(['/packages/:packageId/undo', '/packages/:packageId/redo']);

export function createApi(base: AasStore, options: ApiOptions = {}): (request: ApiRequest) => Promise<ApiResponse> {
  // 🔴 저장소에 작업 공간 겹을 씌운다. 라우트는 **이 겹만** 본다 — 날것의 저장소를 쥔
  //    라우트가 하나라도 있으면 그 길로 남의 파일이 샌다. 문맥을 깔지 않으면(나누지 않는
  //    서버) 이 겹은 아무 일도 하지 않는다
  // 체험판은 **언제나** 나눈다 — 여럿이 같은 계정으로 들어오는데 나누지 않으면 서로의 파일을 본다
  const privateWorkspaces = options.privateWorkspaces === true || options.demo !== undefined;
  const quota = options.maxPackagesPerOwner ?? 50;
  const store = scopeStore(base, privateWorkspaces && quota > 0 ? { maxPackagesPerOwner: quota } : {});
  const undo = new UndoStack(store);
  // 🔴 라우트와 요청 처리가 **같은 세션 표**를 봐야 한다 — 따로 만들면 로그인해도 안 통한다
  const sessions = options.sessions ?? new SessionStore();
  const routes = compile(buildRoutes(store, { ...options, sessions, undo }));

  const auth = options.auth ?? OPEN_ACCESS;
  /**
   * 계정이 생겼는가 — 한 번 참이 되면 다시 묻지 않는다(마지막 관리자는 지울 수 없다).
   * 키가 있는 서버는 어차피 열어 주지 않으므로 묻지도 않는다.
   */
  let accountsExist = false;
  const accountsNow = async (): Promise<boolean> => {
    if (!accountsExist && isOpen(auth)) accountsExist = (await store.countUsers()) > 0;
    return accountsExist;
  };

  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    // 🔴 로그인한 사람이 먼저, 기계용 API 키가 나중이다(auth.ts의 순서 설계).
    //    세션이 없으면 undefined가 가고, 그러면 예전처럼 토큰을 본다.
    const principal = await principalOf(store, sessions, request);
    // 🔴 CSRF — 쿠키로 들어온 **쓰기**만 원점을 따진다. 브라우저가 쿠키를 알아서 싣기
    //    때문에 생기는 위험이고, API 키는 남의 사이트가 붙일 수 없어 해당이 없다
    if (principal) {
      const blocked = crossSiteWrite(request, options.corsOrigins ?? []);
      if (blocked) return blocked;
    }
    // 경로를 찾기 **전에** 막는다. 없는 경로에 대고 토큰을 떠보는 일을 줄인다
    const allowed = authorize(auth, request, principal, principal ? true : await accountsNow());
    if (!allowed.ok) return allowed.response!;
    // 라우트가 "누가 불렀나"를 알아야 하는 자리가 있다(계정 관리·감사 기록).
    // 🔴 푸는 곳은 여기 한 곳 — 라우트가 스스로 다시 풀면 두 해석이 갈린다
    const inbound: ApiRequest = principal ? { ...request, principal } : request;

    const found = match(routes, inbound.method, inbound.path);
    if (found === undefined) {
      return errorResponse(404, 'NotFound', `경로가 없습니다: ${request.method} ${request.path}`);
    }
    if (found === 'method-not-allowed') {
      return errorResponse(405, 'MethodNotAllowed', `허용되지 않는 메서드입니다: ${request.method}`);
    }

    // 「누가」를 **여기 한 번만** 깐다. 라우트와 저장소가 매개변수 없이 집어 쓴다 —
    // 호출 자리 서른 군데에 일일이 끼우면 한 군데만 빠져도 그 변경은 기록이 빈다(actor.ts)
    const actor = actorOf(principal, allowed);
    // 「누구의 눈으로 저장소를 보는가」도 여기 한 번만 깐다. 나누지 않는 서버는 깔지 않는다
    const workspace = privateWorkspaces ? workspaceOf(principal, allowed, options.demo) : undefined;
    return runInWorkspace(workspace, () => runAsActor(actor, async () => {
      try {
        // 되돌리기 — 모델을 바꿀 수 있는 요청은 직전 상태를 찍어 두고, 실제로 달라졌을 때만 쌓는다.
        // 되돌리기 요청 자체는 예외(스택을 스스로 옮긴다). 패키지 삭제는 스택을 버린다
        const packageId = found.params['packageId'];
        // 🔴 주소에 패키지가 든 요청은 **그 패키지가 보이는지부터** 본다(나누는 서버에서만).
        //    저장소 겹이 대부분을 막지만, 저장소 **밖에** 패키지 id로 들고 있는 것이 있다 —
        //    되돌리기 목록이 그렇다(서버 메모리). 그 길로 남의 목록을 읽고, 되돌리기를
        //    시도해 남의 목록을 지울 수 있었다(시험이 잡았다). 여기서 한 번 더 막아,
        //    앞으로 그런 상태가 더 생겨도 빠질 자리가 없게 한다.
        if (workspace && packageId !== undefined && !(await store.getPackage(packageId))) {
          return errorResponse(404, 'NotFound', `패키지 ${packageId}을(를) 찾을 수 없습니다.`);
        }
        const snapshot =
          packageId !== undefined && MUTATING.has(request.method) && !UNDO_PATTERNS.has(found.route.pattern)
            ? await undo.capture(packageId, describeChange(request.method, request.path), actor?.name)
            : undefined;
        const response = await found.route.handle({ request: inbound, params: found.params });
        // 🔴 데모 계정은 **파일을 가지고 나가지 못한다.** 경로가 아니라 나가는 응답을
        //    본다 — 내려받기 경로가 늘어도 빠뜨릴 자리가 없다(demo.ts)
        if (options.demo && isDemoAccount(options.demo, principal) && isFileDownload(response)) {
          return errorResponse(
            403,
            'Forbidden',
            '데모 계정으로는 파일을 내려받을 수 없습니다. 「회원가입」으로 계정을 만들면 받을 수 있습니다.',
          );
        }
        if (snapshot && packageId !== undefined && response.status < 300) {
          if (request.method === 'DELETE' && found.route.pattern === '/packages/:packageId') undo.forget(packageId);
          else await undo.commit(packageId, snapshot);
        }
        return response;
      } catch (error) {
        return toErrorResponse(error);
      }
    }));
  };
}

/**
 * 이 요청의 작업 공간.
 *
 * | 누구 | 열쇠 | 전부 보나 |
 * |---|---|---|
 * | 데모 계정 | `visitor:<로그인마다 다른 이름>` | 아니다 — 같은 계정이라도 서로 못 본다 |
 * | 가입한 사람 | `user:<계정 id>` | 아니다 — 다시 로그인해도 같은 칸이다 |
 * | 관리자 | `user:<계정 id>` | **본다** — 운영하려면 남의 것도 봐야 한다 |
 * | API 키 | `apikey` | **본다** — 기계 연동(레지스트리·수집)은 전체를 다룬다 |
 * | 그 밖 | `anonymous` | 아니다 — 공용(주인 없는 것)만 보인다 |
 *
 * 🔴 데모 계정을 계정 id로 가르면 **모두가 한 칸에 들어간다** — 여럿이 같이 쓰는 한 계정이다.
 */
function workspaceOf(
  principal: Principal | undefined,
  allowed: AuthResult,
  demo: DemoConfig | undefined,
): Workspace {
  if (principal) {
    if (demo && principal.login.toLowerCase() === demo.login.toLowerCase()) {
      return { key: `${VISITOR_PREFIX}${principal.visitor}`, seesAll: false };
    }
    return { key: `user:${principal.userId}`, seesAll: principal.role === 'admin' };
  }
  if (allowed.via === 'apikey') return { key: 'apikey', seesAll: true };
  return { key: 'anonymous', seesAll: false };
}

/** 여럿이 같이 쓰는 데모 계정인가 — 가입해 만든 자기 계정과 가르는 기준 */
function isDemoAccount(demo: DemoConfig, principal: Principal | undefined): boolean {
  // 🔴 로그인하지 않은 상태(인증이 꺼진 서버)도 체험으로 본다 — 공개 서버에서
  //    로그인 없이 들어온 사람에게 내려받기를 열어 주면 막은 뜻이 없다
  if (!principal) return true;
  return principal.login.toLowerCase() === demo.login.toLowerCase();
}

/**
 * 이 요청의 행위자.
 *
 * 🔴 **사람이 아닌 것도 적는다.** API 키로 들어온 변경을 「기록 없음」으로 두면, 나중에
 *    감사 기록을 볼 때 「옛날 기록」과 「기계가 한 일」이 구분되지 않는다. 기계는 기계라고
 *    적되 **어느 키인지는 적지 않는다** — 키 값은 비밀이고, 로그는 평문으로 돌아다닌다.
 * 🔴 인증을 안 쓰는 서버(설치판·개발)는 undefined다. 혼자 쓰는 PC에서 「누가」는 뜻이 없고,
 *    아무 이름이나 적으면 없던 사실을 지어내는 것이다.
 */
function actorOf(principal: Principal | undefined, allowed: AuthResult): Actor | undefined {
  if (principal) return { id: principal.userId, name: principal.displayName };
  if (allowed.via === 'apikey') return { id: 'apikey', name: 'API 키' };
  return undefined;
}

/** 되돌리기·다시 하기 — 규격 밖 연산(EXTENSIONS에 등록) */
function undoRoutes(undo: UndoStack): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/packages/:packageId/undo',
      success: [200],
      handle: async ({ params }) => json(200, undo.status(params['packageId']!)),
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/undo',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const undone = await undo.undo(packageId);
        if (undone === undefined) throw new ApiError(409, 'Conflict', '되돌릴 변경이 없습니다.');
        return json(200, { undone, ...undo.status(packageId) });
      },
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/redo',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const redone = await undo.redo(packageId);
        if (redone === undefined) throw new ApiError(409, 'Conflict', '다시 할 변경이 없습니다.');
        return json(200, { redone, ...undo.status(packageId) });
      },
    },
  ];
}

export function toErrorResponse(error: unknown): ApiResponse {
  if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message);
  if (error instanceof NotFoundError) return errorResponse(404, 'NotFound', error.message);
  if (error instanceof ForbiddenError) return errorResponse(403, 'Forbidden', error.message);
  if (error instanceof ConflictError) return errorResponse(409, 'Conflict', error.message);
  if (error instanceof InvalidContentError) return errorResponse(400, 'BadRequest', error.message);
  if (error instanceof ValueNotSupportedError) return errorResponse(400, 'BadRequest', error.message);
  // 상한 초과는 형식 오류가 아니라 "너무 크다"는 뜻이다 — 413이 맞다(기획서 Ⅷ Zip Bomb)
  if (error instanceof AasxLimitError) return errorResponse(413, 'PayloadTooLarge', error.message);
  if (error instanceof AasxReadError) return errorResponse(400, 'BadRequest', error.message);
  if (error instanceof Error && error.message.startsWith('base64url')) {
    return errorResponse(400, 'BadRequest', error.message);
  }
  // 여기까지 오면 우리가 예상하지 못한 것이다. 원문을 숨기지 않는다 — 폐쇄망 운영에서 진단이 먼저다
  return errorResponse(500, 'InternalServerError', error instanceof Error ? error.message : String(error));
}
