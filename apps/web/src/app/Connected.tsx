/**
 * 연결 부품 — 화면 조각(AppHeader · StatusBanners · Welcome · Splitter)에 App 의 상태·동작을 이어 준다.
 * App.tsx 에서 props 를 엮던 자리를 옮겼다(2026-10-13 컴포넌트화) — 엮는 코드는 옮기기 전과 같다.
 * 조각 자체는 상태를 모르고 props 만 받는다(그래야 따로 시험하고 고칠 수 있다).
 */
import { api, setToken } from '../api.js';
import { Rules } from '../components/Rules.js';
import { Splitter } from '../components/Splitter.js';
import { tr } from '../i18n.js';
import { DEFAULT_PANES } from '../panes.js';
import { Dialog } from '../ui/Dialog.js';
import { AppHeader } from './AppHeader.js';
import type { Screen } from './context.js';
import { describeError } from './describeError.js';
import { exportMenuItems, fileMenuItems, settingsMenuItems, submodelMenuItems } from './headerMenus.js';
import { StatusBanners } from './StatusBanners.js';
import { Welcome } from './Welcome.js';

type S = Screen;

export function HeaderBar(s: Pick<S, 't' | 'lang' | 'version' | 'packages' | 'packageId' | 'busy' | 'demoLocked' | 'errors' | 'warnings' | 'fixable' | 'unfixable' | 'linkedFixable' | 'opcua' | 'undoState' | 'showHelp' | 'fileInput' | 'bundleInput' | 'setAdding' | 'setFilesOpen' | 'setPickedFiles' | 'onOpenSample' | 'auth' | 'theme' | 'bootstrap' | 'setShowSettings' | 'setStartAccounts' | 'setShowAccounts' | 'setConfirmQuit' | 'setShowRules' | 'shell' | 'fileUnit' | 'run' | 'goHome' | 'loadPackage' | 'onUpload' | 'onOpenBundle' | 'onUndo' | 'onRedo' | 'onFix' | 'onDownload' | 'setShowFindings' | 'setShowHelp' | 'setShowOpcua'>): React.JSX.Element {
  const { t, busy, demoLocked, packages, fileInput, bundleInput, setAdding, setFilesOpen, setPickedFiles, onOpenSample, lang, auth, theme, bootstrap, setShowSettings, setStartAccounts, setShowAccounts, setConfirmQuit, setShowRules, shell, packageId, fileUnit, run } = s;
  return (
    <AppHeader
      t={t}
      lang={lang}
      version={s.version}
      packages={packages}
      packageId={packageId}
      busy={busy}
      demoLocked={demoLocked}
      errors={s.errors}
      warnings={s.warnings}
      fixable={s.fixable}
      unfixable={s.unfixable}
      linkedFixable={s.linkedFixable}
      opcua={s.opcua}
      undoState={s.undoState}
      showHelp={s.showHelp}
      fileInput={fileInput}
      bundleInput={bundleInput}
      fileMenu={fileMenuItems({ t, busy, demoLocked, packages, fileInput, bundleInput, setAdding, setFilesOpen, setPickedFiles, onOpenSample })}
      settingsMenu={settingsMenuItems({ t, busy, lang, auth, demoLocked, theme, bootstrap, setShowSettings, setStartAccounts, setShowAccounts, setConfirmQuit, setShowRules })}
      submodelMenu={submodelMenuItems({ t, busy, shell, setAdding })}
      exportMenu={packageId ? exportMenuItems({ t, busy, packageId, fileUnit, run, setAdding }) : []}
      goHome={s.goHome}
      loadPackage={s.loadPackage}
      onUpload={s.onUpload}
      onOpenBundle={s.onOpenBundle}
      onUndo={s.onUndo}
      onRedo={s.onRedo}
      onFix={s.onFix}
      onDownload={s.onDownload}
      setShowFindings={s.setShowFindings}
      setShowHelp={s.setShowHelp}
      setShowOpcua={s.setShowOpcua}
      setStartAccounts={setStartAccounts}
    />
  );
}

export function Banners(s: Pick<S, 't' | 'confirmQuit' | 'setConfirmQuit' | 'bootstrap' | 'setError' | 'demoLocked' | 'sampleLocked' | 'auth' | 'setStartAccounts' | 'setSampleLocked' | 'error' | 'needsToken' | 'setNeedsToken' | 'conflict' | 'packageId' | 'loadPackage' | 'notice' | 'setNotice' | 'fixReport' | 'setFixReport'>): React.JSX.Element {
  const { setConfirmQuit, bootstrap, setError, error, needsToken, conflict, notice, fixReport, packageId, loadPackage } = s;
  return (
    <StatusBanners
      t={s.t}
      confirmQuit={s.confirmQuit}
      onQuit={() => {
        setConfirmQuit(false);
        void api
          .deleteMe()
          .then(() => bootstrap())
          .catch((caught: unknown) => setError(describeError(caught)));
      }}
      onCancelQuit={() => setConfirmQuit(false)}
      demoLocked={s.demoLocked}
      sampleLocked={s.sampleLocked}
      signupAllowed={s.auth?.signupAllowed === true}
      onSignup={() => s.setStartAccounts(true)}
      onCloseSampleLocked={() => s.setSampleLocked(false)}
      {...(error ? { error } : {})}
      onCloseError={() => setError(undefined)}
      {...(needsToken !== undefined ? { needsToken } : {})}
      onToken={(token) => {
        setToken(token);
        s.setNeedsToken(undefined);
        void bootstrap();
      }}
      {...(conflict ? { conflict } : {})}
      onReload={() => {
        if (packageId) void loadPackage(packageId);
      }}
      {...(notice ? { notice } : {})}
      onCloseNotice={() => s.setNotice(undefined)}
      {...(fixReport ? { fixReport } : {})}
      onCloseFixReport={() => s.setFixReport(undefined)}
    />
  );
}

/** 규칙·규약 — 지적 목록·내주기와 같은 팝업. 예전엔 헤더 밑 띠로 끼어들어 본문을 밀어냈다(2026-09-09 디자인 검토) */
export function RulesDialog({ showRules, setShowRules }: Pick<S, 'showRules' | 'setShowRules'>): React.JSX.Element | null {
  if (!showRules) return null;
  return (
    <Dialog className="rules-modal" label={tr('규칙과 규약')} onClose={() => setShowRules(false)}>
      <Rules onClose={() => setShowRules(false)} />
    </Dialog>
  );
}

/* 첫 화면 — 열린 파일이 없거나, 로고로 나왔을 때(보는 파일 없음). 빈 세 칸만 띄워 두면 처음 쓰는 사람은 손댈 곳을 찾지 못한다 */
export function WelcomeScreen(s: Pick<S, 't' | 'lang' | 'packages' | 'adding' | 'busy' | 'policy' | 'loadPackage' | 'setAdding' | 'fileInput' | 'bundleInput' | 'onOpenSample' | 'onImportForTree' | 'onCreatePackage'>): React.JSX.Element {
  const { policy, loadPackage, setAdding, fileInput, bundleInput, onOpenSample, onCreatePackage } = s;
  return (
    <Welcome
      t={s.t}
      lang={s.lang}
      packages={s.packages}
      creating={s.adding === 'new'}
      busy={s.busy}
      {...(policy ? { policy } : {})}
      onOpenPackage={(id) => void loadPackage(id)}
      onPickFile={() => {
        setAdding(undefined);
        fileInput.current?.click();
      }}
      onPickBundle={() => bundleInput.current?.click()}
      onStartNew={() => setAdding('new')}
      onCancelNew={() => setAdding(undefined)}
      onOpenSample={() => void onOpenSample()}
      onImportFile={s.onImportForTree}
      onCreate={(name, extras, unit, tree) => void onCreatePackage(name, extras, unit, tree)}
    />
  );
}

/** 칸 사이 손잡이 — 왼쪽(트리|가운데) · 오른쪽(가운데|오른쪽 칸) */
export function PaneSplitter({ side, shownPanes, movePane, setPanes, commitPanes }: { side: 'left' | 'right' } & Pick<S, 'shownPanes' | 'movePane' | 'setPanes' | 'commitPanes'>): React.JSX.Element {
  return side === 'left' ? (
    <Splitter
      label={tr('트리')}
      value={shownPanes.left}
      onMove={(delta) => movePane('left', delta)}
      onReset={() => setPanes((current) => ({ ...current, left: DEFAULT_PANES.left }))}
      onCommit={commitPanes}
    />
  ) : (
    <Splitter
      label={tr('오른쪽 칸')}
      value={shownPanes.right}
      onMove={(delta) => movePane('middle', delta)}
      onReset={() => setPanes((current) => ({ ...current, right: DEFAULT_PANES.right }))}
      onCommit={commitPanes}
    />
  );
}
