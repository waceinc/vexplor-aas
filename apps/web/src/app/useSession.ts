/**
 * 로그인 · 계정 창 · 체험판 · 화면 언어.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 선언과 주석은 옮기기 전 글자 그대로다.
 */
import { useMemo, useState } from 'react';
import { type AuthState } from '../api.js';
import { readLang, translator, type Lang } from '../i18n.js';

export function useSession() {
  /**
   * 화면 글자의 언어 — 이 브라우저에만 남는다(서버 설정이 아니다).
   * 🔴 영어는 화면 뼈대만 있다. 없는 글자는 한국어로 나온다 — i18n.ts 머리말 참조.
   */
  /**
   * 로그인 상태 — 화면이 가장 먼저 묻는다(2026-10-02).
   * 🔴 undefined는 "아직 모른다"다. 모르는 동안 로그인 화면을 띄우면 이미 로그인한 사람에게
   *    한 번 깜빡인다 — 셋 중 하나로 갈릴 때까지 아무 것도 그리지 않는다.
   */
  const [auth, setAuth] = useState<AuthState>();
  /**
   * 「첫 관리자 만들기」를 스스로 연 것인가.
   *
   * 🔴 계정도 토큰도 없는 서버는 로그인 화면을 **띄우지 않는다**(아무도 못 들어가니까).
   *    그런데 그러면 계정을 쓰기 시작할 길도 없다 — 사내 서버로 올려 놓고 "로그인은
   *    어떻게 켜나"가 되는 자리다. 「설정」 메뉴에서 여기로 들어온다.
   */
  const [startAccounts, setStartAccounts] = useState(false);
  /** 탈퇴 확인 — 되돌릴 수 없는 일이라 한 번 묻는다 */
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * 데모 계정으로 보고 있나 — 내려받기가 막힌 상태다.
   * 🔴 가입해 자기 계정으로 들어오면 `auth.demo`가 비고 제한이 풀린다(서버가 정한다).
   */
  const demoLocked = auth?.demo !== undefined;
  /** 데모 계정이 견본을 눌렀다 — 회원가입 뒤에 쓸 수 있다고 알린다(사용자 2026-10-07) */
  const [sampleLocked, setSampleLocked] = useState(false);
  const [lang] = useState<Lang>(() => readLang());
  const t = useMemo(() => translator(lang), [lang]);
  return { auth, setAuth, startAccounts, setStartAccounts, confirmQuit, setConfirmQuit, demoLocked, sampleLocked, setSampleLocked, lang, t };
}
