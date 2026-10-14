/**
 * Equipment state — the logic moved to `@aas/core` (packages/aas-core/src/integration/states.ts) so the server
 * event detector and this screen judge with the same functions and the same rules (docs/design/integration-v1.md §6).
 * This file only re-exports, so existing imports keep working.
 */
export {
  DEFAULT_STATE_RULES,
  dayWindow,
  normalizeState,
  parseRuleList,
  pickStateTag,
  stateTimeline,
  stateTotals,
  type BarState,
  type MachineState,
  type Segment,
  type StateRules,
} from '@aas/core';
