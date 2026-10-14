/**
 * 저작 UI — 기획서 M3.
 *
 * 한 흐름을 세로로 관통시킨다: 파일 열기 → 트리 편집 → 지적 확인 → 고치기 → 내려받기.
 * Package Explorer를 흉내 내지 않고 **지적을 중심**에 뒀다 — 그게 이 제품의 차별점이기 때문이다.
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
 * 조립만 한다(2026-10-13 컴포넌트화) — 상태·계산·동작은 app/ 의 훅이, 화면은 app/ · components/ 의 부품이 맡는다.
 * 층마다 결과를 하나로 합쳐 다음 층에 넘긴다(층의 뜻은 app/context.ts). 각 훅·부품은 쓰는 이름만 받는 타입이다.
 * 🔴 훅을 부르는 순서를 바꾸지 않는다 — React 는 순서로 훅을 알아보고, 효과도 이 순서로 돈다.
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
    로그인 벽 — 세 갈래로 갈린다.
    🔴 `auth === undefined`는 "아직 모른다"다. 모르는 동안 로그인 화면을 띄우면
       이미 로그인한 사람에게 한 번 깜빡인다. 아무 것도 그리지 않고 기다린다.
    🔴 `authRequired`가 꺼진 서버(계정도 토큰도 없음)에서는 로그인 화면을 띄우지 않는다 —
       넣을 계정이 없어 아무도 들어갈 수 없게 된다(개발·설치판이 이 경우다).
    🔴 토큰(API 키)을 쥐고 있으면 그대로 쓴다 — 기존 사용자를 쫓아내지 않는다.
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
      {/* 머리글은 셸 밀도(90%), 그 아래 본문은 80% — 로직스튜디오 셸과 같은 표(styles/drive.css) */}
      <HeaderBar {...screen} />
      <Banners {...screen} />
      <RulesDialog {...screen} />

      {/*
        🔴 칸 너비를 inline style로 준다. 첫 화면(welcome)일 때도 같은 값을 주지만
           `.welcome`이 `grid-column: 1 / -1`이라 통째로 쓰므로 영향이 없다.
      */}
      <main ref={mainRef} style={{ gridTemplateColumns: gridTemplate(shownPanes) }}>
        {/*
          🔴 「새로 만들기」가 열려 있는 동안은 busy여도 첫 화면을 지킨다. 전에는 첫 화면에서 「PC에서 가져오기」로
             파일을 올리는 순간 busy → 세 칸 화면으로 갈아타며 NewPackage가 **언마운트**돼 만들던 공정·설비 트리가
             통째로 사라졌다(사용자 2026-09-09 "적용 안 되고 나가짐"). !busy 조건은 첫 파일을 여는 동안 첫 화면이
             깜빡이지 않게 둔 것이라, 만들기 폼이 열려 있을 때는 필요 없다
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
