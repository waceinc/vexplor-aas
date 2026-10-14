/**
 * Screen effects — getting-started checklist ticks · first-run tour · F1 help · auto-dismiss of notice strips · Esc closes one thing at a time · Ctrl+Z undo.
 * Split out of App.tsx (componentization, 2026-10-13) — the code is verbatim from before the move,
 * and the state and actions it uses arrive under the same names (taken from c).
 */
import { useCallback, useEffect } from 'react';
import { type StartItem } from '../components/GettingStarted.js';
import { fileTour, tourSeen, welcomeTour, type HelpContext, type StartStep } from '../help.js';
import type { Full } from './context.js';

export function useAppBehavior(c: Pick<Full, 'adding' | 'auth' | 'busy' | 'demoLocked' | 'fileInput' | 'filesOpen' | 'fixPlans' | 'historyFor' | 'markStart' | 'notice' | 'onDownload' | 'onFix' | 'onOpenSample' | 'onRedo' | 'onUndo' | 'packageId' | 'selectedKey' | 'setAdding' | 'setFilesOpen' | 'setHistoryFor' | 'setNotice' | 'setSelectedKey' | 'setShowFindings' | 'setShowHelp' | 'setShowOpcua' | 'setShowRules' | 'setStartAccounts' | 'setTour' | 'showFindings' | 'showHelp' | 'showOpcua' | 'showRules' | 'start' | 't' | 'tour' | 'undoState'>) {
  const { adding, auth, busy, demoLocked, fileInput, filesOpen, fixPlans, historyFor, markStart, notice, onDownload, onFix, onOpenSample, onRedo, onUndo, packageId, selectedKey, setAdding, setFilesOpen, setHistoryFor, setNotice, setSelectedKey, setShowFindings, setShowHelp, setShowOpcua, setShowRules, setStartAccounts, setTour, showFindings, showHelp, showOpcua, showRules, start, t, tour, undoState } = c;
  // Getting-started checklist — opened a file · viewed check results
  useEffect(() => {
    if (packageId) markStart('open');
  }, [packageId, markStart]);
  useEffect(() => {
    if (showFindings) markStart('check');
  }, [showFindings, markStart]);
  /** Signed in? — help widgets are not shown on the login screen */
  const inside = auth !== undefined && !(auth.authRequired && !auth.authenticated);
  /** Current screen — the topic help opens first */
  const helpContext: HelpContext = showFindings || fixPlans ? 'check' : packageId ? 'edit' : 'open';
  const startTour = useCallback((name: string) => {
    setShowHelp(false);
    setTour({ name, steps: name === 'file' ? fileTour() : welcomeTour() });
  }, []);
  /** The four getting-started rows — clicking one starts that task right away (if it can't, says what to do first) */
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
  // Once on first entry and once on first file open. Important: never auto-show in tests (it covers the screen)
  useEffect(() => {
    if (import.meta.env.MODE === 'test' || !inside || tour || showHelp) return;
    const name = packageId ? 'file' : 'welcome';
    if (tourSeen(name)) return;
    const timer = window.setTimeout(() => startTour(name), packageId ? 1400 : 900);
    return () => window.clearTimeout(timer);
  }, [inside, packageId, tour, showHelp, startTour]);
  // F1 — help (instead of the browser's own help)
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
  // Notice strips dismiss themselves — without clicking close, an hour-old notice used to linger
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // Esc — close open things one at a time. If nothing is open, clear the selection
  // Ctrl/⌘+Z — undo; with Shift, redo (inside an input field it belongs to that field)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Esc and Ctrl+Z in a focused input belong to that input (clearing search, undoing typing)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onUndo/onRedo are recreated every render; state is read inside them
  }, [showFindings, showOpcua, showRules, adding, historyFor, filesOpen, selectedKey, busy, packageId, undoState]);
  return { inside, helpContext, startTour, startItems };
}
