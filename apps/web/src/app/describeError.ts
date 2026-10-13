import { ApiError, ForbiddenError } from '../api.js';
import { fill, tr } from '../i18n.js';

/**
 * 서버가 준 문장을 그대로 띄우면 「TypeError: Failed to fetch」 같은 것이 사용자에게 간다.
 * 자주 오는 세 가지만 사람 말로 바꾸고, 나머지는 서버 문장을 그대로 쓴다(그쪽은 이미 한국어다).
 */
export function describeError(caught: unknown): string {
  // 🔴 403은 더 이상 「읽기 전용 토큰」 하나가 아니다 — 보기 전용 **계정**, 다른 사이트에서
  //    온 요청, 설치 코드 불일치도 403이다(2026-10-02). 서버가 왜인지 적어 보내므로
  //    그 문장을 그대로 쓴다. 앞에 토큰 이야기를 붙이면 엉뚱한 안내가 된다
  if (caught instanceof ForbiddenError)
    return caught.message.trim() || tr('권한이 없습니다 — 쓰기 권한이 있는 계정이나 토큰으로 다시 들어오십시오.');
  if (caught instanceof ApiError) {
    if (caught.status === 413) return fill(tr('파일이 상한을 넘습니다 — {0}'), { 0: caught.message });
    return caught.message;
  }
  // fetch 자체가 실패하면 TypeError다 — 서버가 꺼졌거나 주소가 틀렸거나 망이 끊긴 것
  if (caught instanceof TypeError) return tr('서버에 연결할 수 없습니다 — API 서버가 꺼져 있거나 네트워크가 끊겼습니다.');
  return caught instanceof Error ? caught.message : String(caught);
}
