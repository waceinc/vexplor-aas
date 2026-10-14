/**
 * Authoring UI — plan M3.
 *
 * One flow runs top to bottom: open file → edit tree → review findings → fix → download.
 * It does not imitate Package Explorer; **findings sit at the center** — that is what sets this product apart.
 */
import { currentToken } from './api.js';
import { gridTemplate } from './panes.js';
import { useTheme } from './theme.js';
import { Banners, HeaderBar, PaneSplitter, RulesDialog, WelcomeScreen } from './app/Connected.js';
import { LoginScreen } from './app/LoginScreen.js';
import { MiddlePane } from './app/MiddlePane.js';
import { Overlays } from './app/Overlays.js';
import { RightPane } from './app/RightPane.js';
import { TreePane } from './app/TreePane.js';
import { useAppBehavior } from './app/useAppBehavior.js';
import { useCollectionActions } from './app/useCollectionActions.js';
import { useCore } from './app/useCore.js';
import { useDocumentState } from './app/useDocumentState.js';
import { useElementActions } from './app/useElementActions.js';
import { useFileActions } from './app/useFileActions.js';
import { useFixActions } from './app/useFixActions.js';
import { useHierarchyActions } from './app/useHierarchyActions.js';
import { useLinkedFiles } from './app/useLinkedFiles.js';
import { useOnboardingState } from './app/useOnboardingState.js';
import { usePanes } from './app/usePanes.js';
import { useSession } from './app/useSession.js';
import { useStatus } from './app/useStatus.js';
import { useStructureActions } from './app/useStructureActions.js';
import { useTreeModel } from './app/useTreeModel.js';
import { useViewState } from './app/useViewState.js';

export { describeError } from './app/describeError.js';

/**
 * Assembly only (componentized 2026-10-13) — state, computation and actions live in the app/ hooks; screens live in app/ and components/.
 * Each layer merges its results into one object and hands it to the next layer (layer meaning: app/context.ts). Each hook/component is typed to take only the names it uses.
 * Important: do not change the order of hook calls — React identifies hooks by call order, and effects also run in this order.
 */
export function App(): React.JSX.Element {
  const theme = useTheme();
  const base = { theme, ...useDocumentState(), ...useStatus(), ...useViewState(), ...useSession(), ...useOnboardingState(), ...usePanes() };
  useLinkedFiles(base);
  const model = { ...base, ...useTreeModel(base) };
  const core = { ...model, ...useCore(model) };
  const full = {
    ...core,
    ...useFileActions(core),
    ...useElementActions(core),
    ...useStructureActions(core),
    ...useHierarchyActions(core),
    ...useCollectionActions(core),
    ...useFixActions(core),
  };
  const screen = { ...full, ...useAppBehavior(full) };
  const { auth, startAccounts, packages, packageId, busy, adding, mainRef, shownPanes } = screen;

  /*
    Login wall — splits three ways.
    Important: `auth === undefined` means "not known yet". Showing the login screen while unknown
       flashes it once for someone already logged in. Render nothing and wait.
    Important: on a server with `authRequired` off (no accounts, no token) do not show the login screen —
       there is no account to enter, so nobody could get in (the dev and installed builds are this case).
    Important: if a token (API key) is held, use it as is — do not kick out existing users.
  */
  if (auth === undefined) return <div className="app" data-scale="content" />;
  if (
    (auth.authRequired && !auth.authenticated && currentToken() === undefined) ||
    (startAccounts && (auth.setupNeeded || auth.signupAllowed === true))
  ) {
    return <LoginScreen {...screen} auth={auth} />;
  }

  return (
    <div className="app" data-scale="content">
      {/* Header at shell density (90%), body below at 80% — same table as the Logic Studio shell (styles/drive.css) */}
      <HeaderBar {...screen} />
      <Banners {...screen} />
      <RulesDialog {...screen} />

      {/*
        Important: column widths are given as an inline style. The welcome screen gets the same value, but
           `.welcome` is `grid-column: 1 / -1` and spans everything, so it has no effect.
      */}
      <main ref={mainRef} style={{ gridTemplateColumns: gridTemplate(shownPanes) }}>
        {/*
          Important: while "New" is open, keep the welcome screen even when busy. Previously, uploading a file via "Import from PC"
             on the welcome screen switched to the three-pane screen the moment busy turned on, **unmounting** NewPackage and
             wiping the process/equipment tree being built (user 2026-09-09: "not applied, it exits"). The !busy condition exists so the
             welcome screen does not flicker while the first file opens, so it is not needed while the create form is open
        */}
        {(packages.length === 0 || !packageId) && (!busy || adding === 'new') ? (
          <WelcomeScreen {...screen} />
        ) : (
          <>
            <TreePane {...screen} />
            <PaneSplitter side="left" {...screen} />
            <MiddlePane {...screen} />
            <PaneSplitter side="right" {...screen} />
            <RightPane {...screen} />
          </>
        )}
      </main>

      <Overlays {...screen} />
    </div>
  );
}
