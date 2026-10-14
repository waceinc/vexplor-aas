import { ApiError, ForbiddenError } from '../api.js';
import { fill, tr } from '../i18n.js';

/**
 * Showing the server's message verbatim would put things like "TypeError: Failed to fetch" in front of users.
 * Only the three common cases are rephrased in plain language; the rest use the server's message as is (it is already Korean).
 */
export function describeError(caught: unknown): string {
  // Important: 403 no longer means only "read-only token" — a view-only **account**, a request from
  //    another site, and an install-code mismatch are 403 too (2026-10-02). The server sends the reason,
  //    so use that message as is. Prefixing it with token talk would give misleading guidance
  if (caught instanceof ForbiddenError)
    return caught.message.trim() || tr('권한이 없습니다 — 쓰기 권한이 있는 계정이나 토큰으로 다시 들어오십시오.');
  if (caught instanceof ApiError) {
    if (caught.status === 413) return fill(tr('파일이 상한을 넘습니다 — {0}'), { 0: caught.message });
    return caught.message;
  }
  // fetch itself failing throws TypeError — the server is down, the address is wrong, or the network is down
  if (caught instanceof TypeError) return tr('서버에 연결할 수 없습니다 — API 서버가 꺼져 있거나 네트워크가 끊겼습니다.');
  return caught instanceof Error ? caught.message : String(caught);
}
