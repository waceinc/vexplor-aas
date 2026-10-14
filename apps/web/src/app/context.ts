/**
 * Layers of hooks that make up App — each lower layer consumes the upper layer's results under the same names (componentization, 2026-10-13).
 *
 *   Base     screen-state hooks (document · busy state · view · login · help · pane widths · theme)
 *   Model    tree · findings totals · selected element · counts computed from Base   (useTreeModel)
 *   Core     run wrapper (run) · file loading (loadPackage) · initial load · save target   (useCore)
 *   Actions  file · element · composition · collection · fix actions                    (use*Actions)
 *   Full     all of the above — used by screen effects (useAppBehavior)
 *   Screen   Full + values computed by screen effects (help context · getting-started items) — used by screen pieces (*Pane · Overlays)
 *
 * Each hook takes only Pick<Layer, names it uses> — its dependencies show in its signature.
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
