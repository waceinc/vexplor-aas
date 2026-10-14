/**
 * Header — two rows. The top row shows **which file you are looking at** and its status; the bottom row is **what you can do to that file**.
 * Split out of App.tsx (componentization, 2026-10-13). Menu items are built by headerMenus.ts.
 * The header renders at shell density (90%) — the same scale as the Logic Studio shell (styles/drive.css).
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { LayoutGrid } from 'lucide-react';
import type { PackageDescription, UndoStatus } from '../api.js';
import { Menu, type MenuItem } from '../components/Menu.js';
import { T } from '../components/T.js';
import { fill, tr, type Lang } from '../i18n.js';

interface Props {
  t: (text: string) => string;
  lang: Lang;
  version: string | undefined;
  packages: PackageDescription[];
  packageId: string | undefined;
  busy: boolean;
  demoLocked: boolean;
  errors: number;
  warnings: number;
  /** Count auto-fix will actually change · count left for human judgment · share belonging to linked equipment files */
  fixable: number;
  unfixable: number;
  linkedFixable: number;
  opcua: { running: boolean; variables: number } | undefined;
  undoState: UndoStatus;
  showHelp: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  bundleInput: RefObject<HTMLInputElement | null>;
  fileMenu: MenuItem[];
  settingsMenu: MenuItem[];
  submodelMenu: MenuItem[];
  exportMenu: MenuItem[];
  goHome: () => void;
  loadPackage: (packageId: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onOpenBundle: (file: File) => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onFix: () => Promise<void>;
  onDownload: () => Promise<void>;
  setShowFindings: (open: boolean) => void;
  setShowHelp: Dispatch<SetStateAction<boolean>>;
  setShowOpcua: (open: boolean) => void;
  setStartAccounts: (open: boolean) => void;
}

export function AppHeader({
  t, lang, version, packages, packageId, busy, demoLocked, errors, warnings, fixable, unfixable, linkedFixable, opcua, undoState,
  showHelp, fileInput, bundleInput, fileMenu, settingsMenu, submodelMenu, exportMenu, goHome, loadPackage, onUpload, onOpenBundle,
  onUndo, onRedo, onFix, onDownload, setShowFindings, setShowHelp, setShowOpcua, setStartAccounts,
}: Props): React.JSX.Element {
  return (
    <header data-scale="shell">
      {/*
        Two rows. The top row shows **which file you are looking at** and its status; the bottom row is **what you can do to that file**.
        The bottom row appears only once a file is open — the start screen should not line up buttons that do nothing.
      */}
      <div className="bar">
        {/* Company mark — the same logo goes on the screen, reports and documents */}
        <span
          className="brand"
          title={tr('처음 화면으로')}
          onClick={goHome}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goHome();
          }}
        >
          {/*
            Important: drawn as text (2026-10-02). The name changed from WACE to VEXPLOR, but **there is no VEXPLOR logo
               image yet.** Keeping the old image would show the title VEXPLOR next to a WACE graphic.
               Text is resolution-independent, and if the name changes again only this one line needs to change.
               Switch back to an <img> once the official logo file arrives.
          */}
          <LayoutGrid aria-hidden="true" />
          <span className="wordmark">VEXPLOR</span>
          <span className="product">AAS Studio</span>
          {/* Version number — with several deployments, "which version?" is the first question in any support request */}
          {version && <span className="version" title={tr('제품 판 번호')}>v{version}</span>}
        </span>

        <input
          ref={fileInput}
          type="file"
          accept=".aasx"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onUpload(file);
            event.target.value = '';
          }}
        />
        {/*
          Important: the four file actions are in one menu (2026-10-02). Previously a "File" label plus three buttons
             were laid out and made the top row long. Opening a file is **a one-off action**, so it can be collapsed —
             the frequently used control is the file picker next to it.
        */}
        <Menu
          label={t('파일')}
          title={tr('열기 · 새로 만들기 · 번들 열기 · 파일 목록')}
          disabled={busy}
          items={fileMenu}
        />
        <input
          ref={bundleInput}
          type="file"
          accept=".zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onOpenBundle(file);
            event.target.value = '';
          }}
        />
        <select
          value={packageId ?? ''}
          disabled={busy || packages.length === 0}
          onChange={(event) => void loadPackage(event.target.value)}
        >
          {packages.length === 0 && <option value="">{t('열린 파일 없음')}</option>}
          {packages.length > 0 && !packageId && <option value="">{t('— 파일 고르기 —')}</option>}
          {packages.map((item) => (
            <option key={item.packageId} value={item.packageId}>
              {item.name ?? item.packageId}
            </option>
          ))}
        </select>

        {/* Right side — status */}
        <span className="spacer" />
        {busy && <span className="busy">{t('처리 중…')}</span>}
        {packageId && (
          /* Click to open the list. Not distinguished by color alone — dot + text (for color-vision deficiency) */
          <button
            className={`status chip ${errors === 0 ? 'ok' : 'bad'}`}
            onClick={() => setShowFindings(true)}
            title={tr('눌러서 지적 목록을 봅니다')}
          >
            <span className="dot" aria-hidden="true" />
            {t('위반')} {errors}{lang === 'ko' ? tr('건') : ''}
            <span className="sub"> · {t('경고')} {warnings}{lang === 'ko' ? tr('건') : ''}</span>
          </button>
        )}
        {/*
          Important: **serving** runs in the opposite direction to collection. It used to sit inside the collection panel,
             and with the outgoing address shown right next to the collection controls a user pasted that address
             into "Equipment address" — an incident. Things that flow in different directions belong in different places.
             Hidden on the start screen — users asked what "Serving" meant when no file was even open.
        */}
        {packageId && opcua?.running && (
          <button
            className="status chip out"
            onClick={() => setShowOpcua(true)}
            title={tr('이 도구가 다른 시스템에 값을 내주고 있습니다')}
          >
            {t('→ 내주는 중')}
            <span className="sub">{' '}<T k={'· 변수 {0}개'} v={[opcua.variables]} /></span>
          </button>
        )}
        {/* Help — in-screen instead of a manual (2026-10-08). Kept as text — a lone "?" does not say what it is */}
        <button
          className={`help-trigger${showHelp ? ' on' : ''}`}
          aria-expanded={showHelp}
          title={tr('이 화면에서 할 수 있는 일과 쓰는 법을 봅니다 (F1)')}
          onClick={() => setShowHelp((open) => !open)}
        >
          {t('? 도움말')}
        </button>
        {/*
          Important: Settings (2026-10-02) — gathers things that took header space without being used all the time.
             "Rules" is opened maybe once a day, and "Clear token" only when leaving the desk.
        */}
        <Menu
          // Important: no gear icon (⚙) — on this screen ⚙ marks **equipment** in the tree.
          //    One symbol with two meanings blurs both. Use text instead (user, 2026-10-04)
          label={t('설정')}
          align="right"
          title={t('설정 — 언어 · 계정 · 규칙')}
          items={settingsMenu}
        />
      </div>

      {packageId && (
        <div className="bar work">
          {/* Important: one <span class="group"> per group — in a narrow window (1024px) "Download AASX" alone wrapped to a third line
              and split up the "3 Submit" group (measured 2026-09-09). Groups wrap as a whole */}
          {/* Edit — actions that change the file's contents. Undo comes first — one click reverts a mistake */}
          {/*
            Important: removed the "1 Edit 2 Check 3 Submit" labels (user request, 2026-10-02). The labels took up space,
               and the numbers suggested a fixed order — in practice people fix, check,
               and fix again, going back and forth. Groups are separated by **divider lines** only.
            Important: what to collapse is decided by **frequency of use**. Things clicked every time (undo, auto-fix, download)
               stay outside; only occasional actions go into menus. Making the user click one more time
               has to be worth it.
          */}
          <span className="group">
          <button
            className="undo"
            onClick={() => void onUndo()}
            disabled={busy || undoState.undo.length === 0}
            aria-label={tr('되돌리기')}
            title={
              undoState.undo[0]
                ? fill(tr('되돌리기: {0} (Ctrl+Z){1}'), { 0: undoState.undo[0], 1: undoState.undo.length > 1 ? fill(tr(' · {0}단계 남음'), { 0: undoState.undo.length }) : '' })
                : tr('되돌릴 변경이 없습니다')
            }
          >
            {t('↶ 되돌리기')}
          </button>
          <button
            className="undo"
            onClick={() => void onRedo()}
            disabled={busy || undoState.redo.length === 0}
            aria-label={tr('다시 하기')}
            title={undoState.redo[0] ? fill(tr('다시 하기: {0} (Ctrl+Shift+Z)'), { 0: undoState.redo[0] }) : tr('다시 할 변경이 없습니다')}
          >
            ↷
          </button>
          <span className="sep-line" aria-hidden="true" />
          {/* Important: named "Submodel" — "Add" clashed with the add-element form's button and left unclear what was being added */}
          <Menu
            label={t('서브모델')}
            title={tr('이 파일에 서브모델을 넣습니다')}
            disabled={busy}
            items={submodelMenu}
          />
          <span className="sep-line" aria-hidden="true" />
          {/*
            Important: one blue button per screen — it is "the next thing to click".
               Auto-fix while there is something to fix; download once everything is fixed.
          */}
          <button
            className={fixable > 0 ? 'primary' : ''}
            onClick={() => void onFix()}
            disabled={busy || fixable === 0}
            title={
              fixable === 0
                ? unfixable > 0
                  ? fill(tr('자동으로 고칠 지적이 없습니다 — {0}건은 사람이 판단할 몫입니다(지적 목록 참조)'), { 0: unfixable })
                  : tr('자동으로 고칠 지적이 없습니다')
                : linkedFixable > 0
                  ? tr('고칠 수 있는 지적을 규약대로 교정합니다 — 설비 파일 것은 그 설비 파일에 저장됩니다')
                  : tr('고칠 수 있는 지적(경고 포함)을 규약대로 자동 교정합니다')
            }
          >
            {t('자동 고치기')}{fixable > 0 ? ` ${fixable}${lang === 'ko' ? tr('건') : ''}` : ''}
          </button>
          </span>

          {/* The final step sits at the far right — a finishing action must always be in the same place so the hand remembers it */}
          <span className="spacer" />
          <span className="group submit">
          <Menu
            label={t('내보내기')}
            align="right"
            title={tr('검증 결과서 · 문서용 자료 · 번들을 내보냅니다')}
            disabled={busy}
            items={exportMenu}
          />
          {/* Important: a demo account gets 403 when clicking. Better to say **why it won't work** up front
              than to let users find out by clicking — keep the button and change its description (without it, the app looks like
              "a tool with no download feature") */}
          <button
            className={!demoLocked && fixable === 0 && errors === 0 ? 'primary' : ''}
            onClick={() => (demoLocked ? setStartAccounts(true) : void onDownload())}
            disabled={busy}
            title={
              demoLocked
                ? t('데모 계정으로는 내려받을 수 없습니다 — 눌러서 계정을 만드십시오.')
                : errors > 0
                  ? fill(tr('위반 {0}건이 남아 있습니다 — 받을 수는 있지만 KOSMO 규칙을 아직 다 지키지 못했습니다'), { 0: errors })
                  : tr('지금 파일을 .aasx로 내려받습니다')
            }
          >
            {demoLocked ? `🔒 ${t('AASX 내려받기')}` : t('AASX 내려받기')}
          </button>
          </span>
        </div>
      )}
    </header>
  );
}
