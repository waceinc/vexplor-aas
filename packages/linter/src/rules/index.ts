/**
 * Rule catalog.
 *
 * All three layers must run to leave no gaps (spec §0).
 * There is a measured case where a file passed all three standard validations (aas-core3.1 · official schema · basyx)
 * and still failed the KOSMO Validator, so implementing L3 ourselves is why this product exists.
 */
import type { Rule } from '../types.js';
import { L1_RULES } from './l1-package.js';
import { L2_RULES } from './l2-constraints.js';
import { COLLECT_RULES } from './l3-collect.js';
import { DPP_RULES } from './l3-dpp.js';
import { HIERARCHY_RULES } from './l3-hierarchy.js';
import { KOSMO_AAS_RULES } from './l3-kosmo-aas.js';
import { KOSMO_CD_RULES } from './l3-kosmo-cd.js';
import { KOSMO_SM_RULES } from './l3-kosmo-sm.js';
import { KOSMO_SME_RULES } from './l3-kosmo-sme.js';

export * from './l1-package.js';
export * from './l2-constraints.js';
export * from './l3-collect.js';
export * from './l3-dpp.js';
export * from './l3-hierarchy.js';
export * from './l3-kosmo-aas.js';
export * from './l3-kosmo-cd.js';
export * from './l3-kosmo-sm.js';
export * from './l3-kosmo-sme.js';

/** L3 — KOSMO project rules, then the process (HIER), collection link (AID) and product passport (DPP) checks */
export const L3_RULES: readonly Rule[] = [
  ...KOSMO_AAS_RULES,
  ...KOSMO_SM_RULES,
  ...KOSMO_SME_RULES,
  ...KOSMO_CD_RULES,
  // Process level — applies only to files with a hierarchy submodel (equipment files just pass through)
  ...HIERARCHY_RULES,
  // Collection link (AID) — a password in an address travels with the file (2.8.0)
  ...COLLECT_RULES,
  // Digital Product Passport metadata (IDTA 02099-1) — applies only to files with a DppMetadata submodel
  ...DPP_RULES,
];

/** All rules */
export const ALL_RULES: readonly Rule[] = [...L1_RULES, ...L2_RULES, ...L3_RULES];

export { L1_RULES, L2_RULES };
