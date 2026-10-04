/**
 * 전송 계층에 매이지 않는 요청·응답 모양.
 *
 * 핸들러를 node:http에서 떼어 두면 테스트가 소켓 없이 함수 호출로 끝난다.
 * 실제 서버는 server.ts의 얇은 어댑터가 맡는다.
 */

export interface ApiRequest {
  method: string;
  /** 질의문자열을 뗀 경로 */
  path: string;
  query: Record<string, string>;
  /**
   * 같은 이름이 여러 번 온 질의 인자. 규격이 `?aasIds=..&aasIds=..` 형태를 쓰는 곳이 있다
   * (serialization). 주지 않으면 query의 단일 값을 쓴다.
   */
  queryAll?: Record<string, string[]>;
  /** JSON이면 파싱된 값, 파일 업로드면 바이트 */
  body?: unknown;
  headers: Record<string, string>;
  /**
   * 로그인한 사람 — API가 세션을 풀어 **요청에 실어** 라우트로 보낸다(2026-10-02).
   *
   * 🔴 라우트가 세션을 스스로 다시 풀지 않게 하려는 것이다. 두 군데서 풀면 한쪽만 고쳐져
   *    "화면에서는 관리자인데 이 API만 거절한다"가 된다. 푸는 곳은 api.ts 한 곳뿐이다.
   * 🔴 없을 수 있다 — 토큰(API 키)으로 들어왔거나 인증이 꺼진 서버다.
   */
  principal?: {
    userId: string;
    login: string;
    role: 'admin' | 'editor' | 'viewer';
    displayName: string;
    visitor: string;
  };
  /**
   * 접속한 곳의 주소. 전송 계층(server.ts)이 채운다.
   * 🔴 **세는 데만 쓴다** — 프록시 뒤에서는 믿을 수 없는 값이다(security.ts).
   */
  remoteAddress?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON 직렬화 대상이거나 그대로 내보낼 바이트 */
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
    // 한글 파일명은 ASCII로 접고 UTF-8 원본을 filename*로 함께 준다(기획서 Ⅷ 인코딩 항목)
    headers['content-disposition'] =
      `attachment; filename="download.aasx"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  return { status, headers, body: data };
}

/** IDTA Part 2의 Result/Message 오류 본문 */
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

export function errorResponse(status: number, code: string, text: string): ApiResponse {
  const message: Message = {
    code,
    messageType: 'Error',
    text,
    timestamp: new Date().toISOString(),
  };
  return json(status, { messages: [message] });
}

/** Part 2의 페이지 응답 봉투 */
export function pagedResponse<T>(items: T[], cursor?: string): ApiResponse {
  return json(200, {
    paging_metadata: cursor === undefined ? {} : { cursor },
    result: items,
  });
}
