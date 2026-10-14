/**
 * Busy · error · notice · conflict · token request — the state shown by the band at the top of the screen.
 * Split out of App.tsx (2026-10-13 componentization) — declarations and comments are verbatim from before the move.
 */
import { useState } from 'react';

export function useStatus() {
  /** Guidance text when the server has auth on and the token is missing or wrong */
  const [needsToken, setNeedsToken] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return { needsToken, setNeedsToken, conflict, setConflict, notice, setNotice, busy, setBusy, error, setError };
}
