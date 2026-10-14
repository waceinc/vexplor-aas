/**
 * API 클라이언트 — 로그인 · 계정
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { AuthState, UserView } from './types.js';
import { request, asJson } from './http.js';

export const authApi = {
  // ── 로그인 (2026-10-02) ──────────────────────────────────────────────────
  authMe: (): Promise<AuthState> => request('/auth/me'),
  login: (login: string, password: string): Promise<{ user: AuthState['user'] }> =>
    request('/auth/login', asJson({ login, password })),
  logout: (): Promise<void> => request('/auth/logout', { method: 'POST' }),
  setup: (
    login: string,
    password: string,
    displayName: string,
    setupCode?: string,
  ): Promise<{ user: AuthState['user'] }> =>
    request('/auth/setup', asJson({ login, password, displayName, setupCode })),
  signup: (
    login: string,
    password: string,
    displayName: string,
    email: string,
    company = '',
    agreed = false,
  ): Promise<{ user: AuthState['user'] }> =>
    request('/auth/signup', asJson({ login, password, displayName, email, company, agreed })),
  // ── 계정 관리(관리자) ──
  listUsers: (): Promise<{ result: UserView[] }> => request('/auth/users'),
  createUser: (user: { login: string; displayName: string; role: string; password: string }): Promise<unknown> =>
    request('/auth/users', asJson(user)),
  updateUser: (
    id: string,
    patch: { role?: string; disabled?: boolean; password?: string; displayName?: string },
  ): Promise<unknown> =>
    request(`/auth/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** 관리자가 남의 계정을 지운다 — 그 사람이 올린 파일도 함께. 되돌릴 수 없다 */
  deleteUser: (id: string): Promise<{ deleted: string; files: number }> =>
    request(`/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 탈퇴 — 내 계정을 지운다. 감사 기록의 「누가」는 남는다 */
  deleteMe: (): Promise<void> => request('/auth/me', { method: 'DELETE' }),
  changePassword: (current: string, next: string): Promise<unknown> =>
    request('/auth/password', asJson({ current, next })),
  /** 내 정보 고치기 — 표시 이름 · 회사명 · 이메일. 빈 문자열은 지운다 */
  updateMe: (patch: { displayName?: string; company?: string; email?: string }): Promise<{ user: AuthState['user'] }> =>
    request('/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
};
