/**
 * API 옵션 — createApi 가 받는 설정 한 묶음.
 * api.ts 에서 떼어 냈다(2026-10-14, 300줄 규칙) — 내용과 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { AasxLimits } from '@aas/aasx';
import type { AidInterface, ProtocolReader } from '@aas/collector';
import type { LinterPolicy } from '@aas/linter';
import type { AuthConfig } from './auth.js';
import type { ApiRequest } from './http.js';
import type { DemoConfig } from './demo.js';
import type { Route } from './router.js';
import type { PackageRouteOptions } from './routes/packages.js';
import type { SessionStore, SignupThrottle } from './session.js';
import type { UndoStack } from './undo.js';

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
