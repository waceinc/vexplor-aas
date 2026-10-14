/**
 * API client — login · accounts
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { AuthState, UserView } from './types.js';
import { request, asJson } from './http.js';

export const authApi = {
  // ── Login (2026-10-02) ──────────────────────────────────────────────────
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
  // ── Account management (admin) ──
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
  /** An admin deletes someone else's account — together with the files they uploaded. Irreversible */
  deleteUser: (id: string): Promise<{ deleted: string; files: number }> =>
    request(`/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Withdraw — deletes my own account. The "who" in the audit log is kept */
  deleteMe: (): Promise<void> => request('/auth/me', { method: 'DELETE' }),
  changePassword: (current: string, next: string): Promise<unknown> =>
    request('/auth/password', asJson({ current, next })),
  /** Edit my profile — display name · company · email. An empty string clears the field */
  updateMe: (patch: { displayName?: string; company?: string; email?: string }): Promise<{ user: AuthState['user'] }> =>
    request('/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
};
