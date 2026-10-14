/**
 * 처리 중 · 오류 · 알림 · 충돌 · 토큰 요구 — 화면 위쪽 띠가 보여 주는 상태.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 선언과 주석은 옮기기 전 글자 그대로다.
 */
import { useState } from 'react';

export function useStatus() {
  /** 서버가 인증을 켜 두었는데 토큰이 없거나 틀렸을 때의 안내 문구 */
  const [needsToken, setNeedsToken] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return { needsToken, setNeedsToken, conflict, setConflict, notice, setNotice, busy, setBusy, error, setError };
}
