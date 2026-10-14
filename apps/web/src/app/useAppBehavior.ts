/**
 * 화면 효과 — 시작하기 목록 체크 · 처음 둘러보기 · F1 도움말 · 알림 띠 자동 닫기 · Esc 로 하나씩 닫기 · Ctrl+Z 되돌리기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { useCallback, useEffect } from 'react';
import { type StartItem } from '../components/GettingStarted.js';
import { fileTour, tourSeen, welcomeTour, type HelpContext, type StartStep } from '../help.js';
import type { Full } from './context.js';

export function useAppBehavior(c: Pick<Full, 'adding' | 'auth' | 'busy' | 'demoLocked' | 'fileInput' | 'filesOpen' | 'fixPlans' | 'historyFor' | 'markStart' | 'notice' | 'onDownload' | 'onFix' | 'onOpenSample' | 'onRedo' | 'onUndo' | 'packageId' | 'selectedKey' | 'setAdding' | 'setFilesOpen' | 'setHistoryFor' | 'setNotice' | 'setSelectedKey' | 'setShowFindings' | 'setShowHelp' | 'setShowOpcua' | 'setShowRules' | 'setStartAccounts' | 'setTour' | 'showFindings' | 'showHelp' | 'showOpcua' | 'showRules' | 'start' | 't' | 'tour' | 'undoState'>) {
  const { adding, auth, busy, demoLocked, fileInput, filesOpen, fixPlans, historyFor, markStart, notice, onDownload, onFix, onOpenSample, onRedo, onUndo, packageId, selectedKey, setAdding, setFilesOpen, setHistoryFor, setNotice, setSelectedKey, setShowFindings, setShowHelp, setShowOpcua, setShowRules, setStartAccounts, setTour, showFindings, showHelp, showOpcua, showRules, start, t, tour, undoState } = c;
  // 시작하기 목록 — 파일을 열었다 · 검사 결과를 봤다
  useEffect(() => {
    if (packageId) markStart('open');
  }, [packageId, markStart]);
  useEffect(() => {
    if (showFindings) markStart('check');
  }, [showFindings, markStart]);
  /** 안으로 들어와 있나 — 로그인 화면에서는 도움말 장치를 띄우지 않는다 */
  const inside = auth !== undefined && !(auth.authRequired && !auth.authenticated);
  /** 지금 화면 — 도움말이 먼저 펼칠 주제 */
  const helpContext: HelpContext = showFindings || fixPlans ? 'check' : packageId ? 'edit' : 'open';
  const startTour = useCallback((name: string) => {
    setShowHelp(false);
    setTour({ name, steps: name === 'file' ? fileTour() : welcomeTour() });
  }, []);
  /** 시작하기 목록의 네 줄 — 누르면 그 일을 바로 시작한다(할 수 없으면 무엇을 먼저 할지 알린다) */
  const startItems = (): StartItem[] => {
    const has = (step: StartStep): boolean => start.done.includes(step);
    return [
      {
        id: 'open',
        label: t('파일 열기'),
        hint: demoLocked ? t('내 PC의 AASX를 올려 열어 보세요') : t('견본이나 내 AASX를 열어 보세요'),
        done: has('open'),
        action: demoLocked ? () => fileInput.current?.click() : () => void onOpenSample(),
      },
      {
        id: 'check',
        label: t('검사 결과 보기'),
        hint: packageId ? t('머리줄의 「위반 · 경고」를 누르세요') : t('먼저 파일을 여세요'),
        done: has('check'),
        ...(packageId ? { action: () => setShowFindings(true) } : {}),
      },
      {
        id: 'fix',
        label: t('미리 보고 고치기'),
        hint: packageId ? t('「자동 고치기」로 고칠 항목을 전 / 후로 확인합니다') : t('먼저 파일을 여세요'),
        done: has('fix'),
        ...(packageId ? { action: () => void onFix() } : {}),
      },
      demoLocked
        ? {
            id: 'download',
            label: t('회원가입하고 내려받기'),
            hint: t('데모 계정은 내려받기가 막혀 있습니다'),
            done: has('download'),
            action: () => setStartAccounts(true),
          }
        : {
            id: 'download',
            label: t('파일 내려받기'),
            hint: packageId ? t('완성본을 .aasx로 받습니다') : t('먼저 파일을 여세요'),
            done: has('download'),
            ...(packageId ? { action: () => void onDownload() } : {}),
          },
    ];
  };
  // 처음 들어왔을 때 · 처음 파일을 열었을 때 한 번씩. 🔴 시험에서는 저절로 띄우지 않는다(화면을 덮는다)
  useEffect(() => {
    if (import.meta.env.MODE === 'test' || !inside || tour || showHelp) return;
    const name = packageId ? 'file' : 'welcome';
    if (tourSeen(name)) return;
    const timer = window.setTimeout(() => startTour(name), packageId ? 1400 : 900);
    return () => window.clearTimeout(timer);
  }, [inside, packageId, tour, showHelp, startTour]);
  // F1 — 도움말 (브라우저 자체 도움말 대신)
  useEffect(() => {
    if (!inside) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'F1') {
        event.preventDefault();
        setShowHelp((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inside]);
  // 알림 띠는 저절로 사라진다 — 닫기를 누르지 않으면 한 시간 전 알림이 그대로 남아 있었다
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // Esc — 열린 것부터 하나씩 닫는다. 아무것도 안 열려 있으면 선택을 내려놓는다
  // Ctrl/⌘+Z — 되돌리기, Shift를 더하면 다시 하기(입력 칸 안에서는 그 칸의 몫)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 입력 중인 칸의 Esc·Ctrl+Z는 그 칸의 몫이다(검색창 비우기·글자 되돌리기)
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !busy) {
        event.preventDefault();
        void (event.shiftKey ? onRedo() : onUndo());
        return;
      }
      if (event.key !== 'Escape') return;
      if (showFindings) setShowFindings(false);
      else if (showOpcua) setShowOpcua(false);
      else if (showRules) setShowRules(false);
      else if (adding) setAdding(undefined);
      else if (historyFor) setHistoryFor(undefined);
      else if (filesOpen) setFilesOpen(false);
      else if (selectedKey) setSelectedKey(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onUndo/onRedo는 매 렌더 새로 만들어진다; 상태는 그 안에서 읽는다
  }, [showFindings, showOpcua, showRules, adding, historyFor, filesOpen, selectedKey, busy, packageId, undoState]);
  return { inside, helpContext, startTour, startItems };
}
