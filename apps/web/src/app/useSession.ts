/**
 * Login · account dialog · trial · UI language.
 * Split out of App.tsx (2026-10-13 componentization) — declarations and comments are verbatim from before the move.
 */
import { useMemo, useState } from 'react';
import { type AuthState } from '../api.js';
import { readLang, translator, type Lang } from '../i18n.js';

export function useSession() {
  /**
   * UI text language — stored only in this browser (not a server setting).
   * Important: English covers only the UI skeleton. Missing strings appear in Korean — see the i18n.ts header.
   */
  /**
   * Login state — the first thing the screen asks (2026-10-02).
   * Important: undefined means "not known yet". Showing the login screen while unknown makes it flash once for
   *    someone already logged in — draw nothing until it resolves to one of the three.
   */
  const [auth, setAuth] = useState<AuthState>();
  /**
   * Whether "Create first admin" was opened by the user.
   *
   * Important: a server with neither accounts nor tokens does **not show** the login screen (nobody could get in).
   *    But then there is no way to start using accounts — the spot where, after deploying to an in-house server, one asks
   *    "how do I turn login on?". Reached from the "Settings" menu.
   */
  const [startAccounts, setStartAccounts] = useState(false);
  /** Account deletion confirmation — irreversible, so ask once */
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * Whether viewing with a demo account — downloads are blocked.
   * Important: after signing up and logging in with one's own account, `auth.demo` is empty and the limits lift (the server decides).
   */
  const demoLocked = auth?.demo !== undefined;
  /** The demo account clicked a sample — tell them it is available after sign-up (user 2026-10-07) */
  const [sampleLocked, setSampleLocked] = useState(false);
  const [lang] = useState<Lang>(() => readLang());
  const t = useMemo(() => translator(lang), [lang]);
  return { auth, setAuth, startAccounts, setStartAccounts, confirmQuit, setConfirmQuit, demoLocked, sampleLocked, setSampleLocked, lang, t };
}
