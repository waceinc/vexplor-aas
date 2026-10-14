/**
 * Overlays — serving dialog · auto-fix preview · account · settings · integrations · findings list · help · tour · getting-started checklist.
 * Split out of App.tsx (componentization, 2026-10-13) — markup, class names and comments are verbatim from before the move,
 * and the state and actions it uses arrive as props with the same names.
 */
import { FindingsPanel } from '../components/FindingsPanel.js';
import { FixPreview } from '../components/FixPreview.js';
import { Accounts } from '../components/Accounts.js';
import { Settings } from '../components/Settings.js';
import { Integrations } from '../components/integrations/Integrations.js';
import { writeLang, tr } from '../i18n.js';
import { describeError } from './describeError.js';
import { OpcuaDialog } from './OpcuaDialog.js';
import { Dialog } from '../ui/Dialog.js';
import { GettingStarted } from '../components/GettingStarted.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { Tour } from '../components/Tour.js';
import { markTourSeen, START_STEPS, writeStart } from '../help.js';
import type { Screen } from './context.js';

export function Overlays(props: Pick<Screen, 'allFindings' | 'auth' | 'bootstrap' | 'busy' | 'fixPlans' | 'fixReport' | 'helpContext' | 'inside' | 'lang' | 'onApplyFix' | 'onSelectFinding' | 'opcua' | 'packageId' | 'packages' | 'selected' | 'setFixPlans' | 'setShowAccounts' | 'setShowFindings' | 'setShowHelp' | 'setShowIntegrations' | 'setShowOpcua' | 'setShowSettings' | 'setStart' | 'setTour' | 'showAccounts' | 'showFindings' | 'showHelp' | 'showIntegrations' | 'showOpcua' | 'showSettings' | 'start' | 'startItems' | 'startTour' | 't' | 'tour'>): React.JSX.Element {
  const { allFindings, auth, bootstrap, busy, fixPlans, fixReport, helpContext, inside, lang, onApplyFix, onSelectFinding, opcua, packageId, packages, selected, setFixPlans, setShowAccounts, setShowFindings, setShowHelp, setShowIntegrations, setShowOpcua, setShowSettings, setStart, setTour, showAccounts, showFindings, showHelp, showIntegrations, showOpcua, showSettings, start, startItems, startTour, t, tour } = props;

  return (
    <>
      {/*
        Serving popup — pins down here **what kind of address** this is.
        Important: the incident was caused by "two addresses that both just looked like 'address'".
      */}
      {showOpcua && opcua?.running && (
        <OpcuaDialog
          {...(opcua.endpoint ? { endpoint: opcua.endpoint } : {})}
          packages={opcua.packages}
          variables={opcua.variables}
          onClose={() => setShowOpcua(false)}
        />
      )}

      {/*
        Findings list — shown only on demand. Opens when the header's "N violations" is clicked.
        Important: clicking a finding must take you to that element, so navigate **after closing** —
           while the popup covers the screen you cannot see where you went.
      */}
      {/* Auto-fix preview — grouped by file with before/after per item; only checked items are applied */}
      {fixPlans && (
        <Dialog className="fix-modal" label={tr('자동 고치기 미리보기')} onClose={() => setFixPlans(undefined)}>
          <FixPreview
            plans={fixPlans}
            busy={busy}
            onApply={(select) => void onApplyFix(select)}
            onCancel={() => setFixPlans(undefined)}
          />
        </Dialog>
      )}

      {showAccounts && auth?.user && (
        <Dialog
          className={showAccounts === 'people' ? 'accounts-modal' : 'accounts-modal mine-modal'}
          label={t('계정')}
          onClose={() => setShowAccounts(undefined)}
        >
            <Accounts
              key={showAccounts}
              me={auth.user}
              mode={showAccounts}
              onOpenMine={() => setShowAccounts('mine')}
              t={t}
              describeError={describeError}
              onChanged={() => void bootstrap()}
              onClose={() => setShowAccounts(undefined)}
            />
        </Dialog>
      )}

      {/* Settings — currently just the language. Applied immediately on selection and remembered in this browser */}
      {showSettings && (
        <Dialog label={tr('설정')} onClose={() => setShowSettings(false)}>
            <Settings
              lang={lang}
              t={t}
              onChange={(next) => {
                if (next === lang) return;
                writeLang(next);
                // Important: reload — the string tables at the top of files are fixed to the language read first (i18n.ts `current`).
                //    Changing only state and re-rendering would leave the UI half English, half Korean
                window.location.reload();
              }}
              onClose={() => setShowSettings(false)}
            />
        </Dialog>
      )}

      {/* Integrations — MES / ERP / CMMS. The window decides per role which tabs exist (components/integrations) */}
      {showIntegrations && (
        <Dialog className="integrations-modal" label={tr('연동')} onClose={() => setShowIntegrations(false)}>
          <Integrations auth={auth} packages={packages} onClose={() => setShowIntegrations(false)} />
        </Dialog>
      )}

      {showFindings && (
        // The property pane also has a "Close ✕" — give this one a separate accessible name saying what it closes
        <Dialog
          label={tr('지적 목록')}
          onClose={() => setShowFindings(false)}
          close={{ text: tr('닫기 ✕'), label: tr('지적 목록 닫기') }}
        >
            <FindingsPanel
              findings={allFindings}
              {...(fixReport ? { skipped: fixReport.skipped } : {})}
              {...(selected ? { activePointer: selected.pointer } : {})}
              onSelect={(finding) => {
                setShowFindings(false);
                onSelectFinding(finding);
              }}
            />
        </Dialog>
      )}

      {showHelp && (
        <HelpPanel
          context={helpContext}
          t={t}
          onClose={() => setShowHelp(false)}
          onTour={() => startTour(packageId ? 'file' : 'welcome')}
          onChecklist={() => {
            const next = { ...start, hidden: false };
            writeStart(next);
            setStart(next);
            setShowHelp(false);
          }}
        />
      )}

      {tour && (
        <Tour
          key={tour.name}
          steps={tour.steps}
          t={t}
          onClose={() => {
            markTourSeen(tour.name);
            setTour(undefined);
          }}
        />
      )}

      {/* Getting-started checklist — disappears once done or closed. Reopen it from "? Help" */}
      {inside && !start.hidden && !tour && start.done.length < START_STEPS.length && (
        <GettingStarted
          t={t}
          items={startItems()}
          onHide={() => {
            const next = { ...start, hidden: true };
            writeStart(next);
            setStart(next);
          }}
        />
      )}
    </>
  );
}
