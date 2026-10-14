/**
 * 떠 있는 것들 — 내주기 창 · 자동 고치기 미리보기 · 계정 · 설정 · 지적 목록 · 도움말 · 둘러보기 · 시작하기 목록.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업 · 클래스 이름 · 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름의 props 로 받는다.
 */
import { FindingsPanel } from '../components/FindingsPanel.js';
import { FixPreview } from '../components/FixPreview.js';
import { Accounts } from '../components/Accounts.js';
import { Settings } from '../components/Settings.js';
import { writeLang, tr } from '../i18n.js';
import { describeError } from './describeError.js';
import { OpcuaDialog } from './OpcuaDialog.js';
import { Dialog } from '../ui/Dialog.js';
import { GettingStarted } from '../components/GettingStarted.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { Tour } from '../components/Tour.js';
import { markTourSeen, START_STEPS, writeStart } from '../help.js';
import type { Screen } from './context.js';

export function Overlays(props: Pick<Screen, 'allFindings' | 'auth' | 'bootstrap' | 'busy' | 'fixPlans' | 'fixReport' | 'helpContext' | 'inside' | 'lang' | 'onApplyFix' | 'onSelectFinding' | 'opcua' | 'packageId' | 'selected' | 'setFixPlans' | 'setShowAccounts' | 'setShowFindings' | 'setShowHelp' | 'setShowOpcua' | 'setShowSettings' | 'setStart' | 'setTour' | 'showAccounts' | 'showFindings' | 'showHelp' | 'showOpcua' | 'showSettings' | 'start' | 'startItems' | 'startTour' | 't' | 'tour'>): React.JSX.Element {
  const { allFindings, auth, bootstrap, busy, fixPlans, fixReport, helpContext, inside, lang, onApplyFix, onSelectFinding, opcua, packageId, selected, setFixPlans, setShowAccounts, setShowFindings, setShowHelp, setShowOpcua, setShowSettings, setStart, setTour, showAccounts, showFindings, showHelp, showOpcua, showSettings, start, startItems, startTour, t, tour } = props;

  return (
    <>
      {/*
        내주기 팝업 — 이 주소가 **어떤 종류의 주소인지** 여기서 못박는다.
        🔴 사고의 원인이 「주소가 두 개인데 둘 다 그냥 '주소'로 보인 것」이었다.
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
        지적 목록 — 볼 때만 뜬다. 헤더의 「위반 N건」을 누르면 열린다.
        🔴 지적을 누르면 그 요소로 가야 하므로 **닫고 나서** 이동한다 —
           팝업이 덮고 있으면 어디로 갔는지 볼 수 없다.
      */}
      {/* 자동 고치기 미리보기 — 파일별로 묶어 항목별 전/후, 체크한 것만 반영 */}
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

      {/* 설정 — 지금은 언어 하나. 고르면 바로 적용되고 이 브라우저에 남는다 */}
      {showSettings && (
        <Dialog label={tr('설정')} onClose={() => setShowSettings(false)}>
            <Settings
              lang={lang}
              t={t}
              onChange={(next) => {
                if (next === lang) return;
                writeLang(next);
                // 🔴 새로 읽는다 — 파일 맨 위의 글자표는 처음 읽힌 언어로 굳어 있다(i18n.ts `current`).
                //    상태만 바꿔 다시 그리면 반은 영어, 반은 한국어가 된다
                window.location.reload();
              }}
              onClose={() => setShowSettings(false)}
            />
        </Dialog>
      )}

      {showFindings && (
        // 속성 칸에도 「닫기 ✕」가 있다 — 무엇을 닫는지 읽어 주는 이름을 따로 준다
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

      {/* 시작하기 목록 — 다 했거나 닫으면 사라진다. 「? 도움말」에서 다시 꺼낸다 */}
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
