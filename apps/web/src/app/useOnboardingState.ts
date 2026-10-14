/**
 * In-screen help · tour · getting-started checklist.
 * Split out of App.tsx (2026-10-13 componentization) — declarations and comments are verbatim from before the move.
 */
import { useCallback, useState } from 'react';
import { readStart, writeStart, type StartState, type StartStep, type TourStep } from '../help.js';

export function useOnboardingState() {
  /**
   * In-screen help (2026-10-08) — so the manual need not be opened separately.
   * Help panel · walkthrough guide · getting-started checklist. The text lives in one place, help.ts.
   */
  const [showHelp, setShowHelp] = useState(false);
  const [tour, setTour] = useState<{ name: string; steps: TourStep[] }>();
  const [start, setStart] = useState<StartState>(() => readStart());
  const markStart = useCallback((step: StartStep) => {
    setStart((current) => {
      if (current.done.includes(step)) return current;
      const next = { ...current, done: [...current.done, step] };
      writeStart(next);
      return next;
    });
  }, []);
  return { showHelp, setShowHelp, tour, setTour, start, setStart, markStart };
}
