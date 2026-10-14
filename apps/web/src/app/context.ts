/**
 * App 을 이루는 훅들의 층 — 아래 층이 위 층의 결과를 이름 그대로 받아 쓴다(2026-10-13 컴포넌트화).
 *
 *   Base     화면 상태 훅들(문서 · 처리 상태 · 화면 · 로그인 · 도움말 · 칸 너비 · 테마)
 *   Model    Base 로 계산한 트리 · 지적 합산 · 고른 요소 · 건수        (useTreeModel)
 *   Core     실행 틀(run) · 파일 읽기(loadPackage) · 처음 읽기 · 저장 대상 (useCore)
 *   Actions  파일 · 요소 · 구성 · 수집 · 고치기 동작                    (use*Actions)
 *   Full     위 전부 — 화면 효과(useAppBehavior)가 쓴다
 *   Screen   Full + 화면 효과의 계산값(도움말 문맥 · 시작하기 항목) — 화면 조각(*Pane · Overlays)이 쓴다
 *
 * 각 훅은 Pick<층, 쓰는 이름> 만 받는다 — 무엇에 기대는지가 서명에 드러난다.
 */
import type { useTheme } from '../theme.js';
import type { useDocumentState } from './useDocumentState.js';
import type { useStatus } from './useStatus.js';
import type { useViewState } from './useViewState.js';
import type { useSession } from './useSession.js';
import type { useOnboardingState } from './useOnboardingState.js';
import type { usePanes } from './usePanes.js';
import type { useTreeModel } from './useTreeModel.js';
import type { useCore } from './useCore.js';
import type { useFileActions } from './useFileActions.js';
import type { useElementActions } from './useElementActions.js';
import type { useStructureActions } from './useStructureActions.js';
import type { useHierarchyActions } from './useHierarchyActions.js';
import type { useCollectionActions } from './useCollectionActions.js';
import type { useFixActions } from './useFixActions.js';
import type { useAppBehavior } from './useAppBehavior.js';

export type Base = ReturnType<typeof useDocumentState> &
  ReturnType<typeof useStatus> &
  ReturnType<typeof useViewState> &
  ReturnType<typeof useSession> &
  ReturnType<typeof useOnboardingState> &
  ReturnType<typeof usePanes> & { theme: ReturnType<typeof useTheme> };
export type Model = Base & ReturnType<typeof useTreeModel>;
export type Core = Model & ReturnType<typeof useCore>;
export type Full = Core &
  ReturnType<typeof useFileActions> &
  ReturnType<typeof useElementActions> &
  ReturnType<typeof useStructureActions> &
  ReturnType<typeof useHierarchyActions> &
  ReturnType<typeof useCollectionActions> &
  ReturnType<typeof useFixActions>;
export type Screen = Full & ReturnType<typeof useAppBehavior>;
