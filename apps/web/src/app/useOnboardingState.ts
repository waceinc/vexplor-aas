/**
 * 화면 안 도움말 · 둘러보기 · 시작하기 목록.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 선언과 주석은 옮기기 전 글자 그대로다.
 */
import { useCallback, useState } from 'react';
import { readStart, writeStart, type StartState, type StartStep, type TourStep } from '../help.js';

export function useOnboardingState() {
  /**
   * 화면 안 도움말(2026-10-08) — 매뉴얼을 따로 펼치지 않게.
   * 도움말 패널 · 따라 하기 안내 · 시작하기 목록. 글은 help.ts 한 곳에 있다.
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
