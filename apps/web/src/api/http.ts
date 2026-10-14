/**
 * API 클라이언트 — 요청 틀 · 오류 · 접근 토큰 · 내려받기 도우미.
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import { tr, fill, currentLang } from '../i18n.js';

/** Part 2는 경로에 들어가는 id를 base64url로 인코딩하도록 정한다 */
export function encodeIdentifier(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 리비전이 어긋났을 때 — 다른 곳에서 먼저 바뀌었다는 뜻이다 */
export class ConflictError extends ApiError {}

/** 토큰이 없거나 틀렸다 (401) */
export class UnauthorizedError extends ApiError {}

/** 읽기 전용 토큰으로 고치려 했다 (403) */
export class ForbiddenError extends ApiError {}

/**
 * 접근 토큰.
 *
 * 서버가 인증을 켜고 있으면 모든 요청에 `Authorization: Bearer`로 붙는다.
 * 브라우저에 남겨 두는 이유는 새로고침마다 다시 묻지 않기 위해서다 —
 * 폐쇄망 공용 PC라면 「토큰 지우기」로 지운다.
 */
const TOKEN_KEY = 'aas.token';
let token: string | undefined = readStoredToken();

function readStoredToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // 사생활 보호 모드 등 — 없으면 없는 대로 쓴다
  }
}

export function setToken(value: string | undefined): void {
  token = value?.trim() || undefined;
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* 저장 못 해도 이번 세션은 동작한다 */
  }
}

export function currentToken(): string | undefined {
  return token;
}

/** 토큰을 얹은 헤더를 만든다 */
/**
 * 보내는 것 둘 — 세션 쿠키와 (있으면) API 키.
 *
 * 🔴 `credentials: 'same-origin'`은 fetch의 기본값이지만 **적어 둔다.** 로그인 세션이
 *    쿠키로만 오가므로, 누가 모르고 'omit'으로 바꾸면 로그인이 통째로 안 되고
 *    그 이유를 찾기 어렵다.
 * 🔴 세션 열쇠는 화면이 만지지 않는다 — HttpOnly라 스크립트가 읽을 수도 없다.
 */
export function withAuth(init?: RequestInit): RequestInit {
  // 🔴 고른 언어를 서버에 싣는다 — 지적 문구 · 결과서 · 오류처럼 서버가 만드는 글이 그 언어로 온다.
  //    브라우저 기본 Accept-Language(ko-KR,…,en…)에 맡기면 화면 설정과 서버 글이 갈린다
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    'accept-language': currentLang(),
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return { ...init, credentials: 'same-origin', headers };
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withAuth(init));
  if (!response.ok) {
    // 규격의 Result/Message 본문을 사람이 읽을 한 줄로 만든다
    let text = `${response.status} ${response.statusText}`;
    let fromApi = false;
    try {
      const body = (await response.json()) as { messages?: { text: string }[] };
      fromApi = true;
      if (body.messages?.[0]?.text) text = body.messages[0].text;
    } catch {
      /* 본문이 JSON이 아닐 수 있다 */
    }
    // 🔴 JSON이 아닌 5xx는 API가 낸 것이 아니다 — 그 앞(Vite 프록시·리버스 프록시)이 API에 닿지 못한 모습.
    //    「500 Internal Server Error」를 그대로 보이면 사람은 자기 파일이 잘못된 줄 안다
    if (!fromApi && response.status >= 500) {
      text = tr('API 서버에 연결할 수 없습니다 — 8080이 떠 있는지 확인하십시오 (개발: npm run dev:api).');
    }
    if (response.status === 409) throw new ConflictError(409, text);
    if (response.status === 401) throw new UnauthorizedError(401, text);
    if (response.status === 403) throw new ForbiddenError(403, text);
    throw new ApiError(response.status, text);
  }
  if (response.status === 204) return undefined as T;
  // 🔴 HTML이 왔다는 것은 API가 아니라 **화면 서버**가 답한 것이다(개발 프록시에 이 경로가 없을 때).
  //    「Unexpected token '<'」 원문을 사람에게 보이지 않는다 — 어디를 고칠지 말해 준다
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new ApiError(response.status, fill(tr('API 응답이 아닙니다 ({0}) — 개발 서버 프록시(vite.config.ts)에 이 경로가 빠져 있습니다.'), { 0: path }));
  }
  return (await response.json()) as T;
}

export const asJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function toError(response: Response): Promise<ApiError> {
  let text = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { messages?: { text: string }[] };
    if (body.messages?.[0]?.text) text = body.messages[0].text;
  } catch {
    /* 본문이 JSON이 아닐 수 있다 */
  }
  if (response.status === 401) return new UnauthorizedError(401, text);
  if (response.status === 403) return new ForbiddenError(403, text);
  return new ApiError(response.status, text);
}

/** content-disposition의 filename*(UTF-8)을 먼저 본다 — 한글 파일명이 여기 산다 */
export function filenameOf(response: Response): string | undefined {
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="([^"]+)"/i.exec(disposition)?.[1];
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
