/**
 * 규칙 카탈로그.
 *
 * 세 계층을 모두 실행해야 새는 구멍이 없다(명세 §0).
 * 표준 3중 검증(aas-core3.1 · 공식 스키마 · basyx)을 다 통과한 파일이
 * KOSMO Validator에서 떨어진 실측 사례가 있어, L3를 자체 구현하는 것이 본 제품의 존재 이유다.
 */
import type { Rule } from '../types.js';
import { L1_RULES } from './l1-package.js';
import { L2_RULES } from './l2-constraints.js';
import { HIERARCHY_RULES } from './l3-hierarchy.js';
import { KOSMO_AAS_RULES } from './l3-kosmo-aas.js';
import { KOSMO_CD_RULES } from './l3-kosmo-cd.js';
import { KOSMO_SM_RULES } from './l3-kosmo-sm.js';
import { KOSMO_SME_RULES } from './l3-kosmo-sme.js';

export * from './l1-package.js';
export * from './l2-constraints.js';
export * from './l3-hierarchy.js';
export * from './l3-kosmo-aas.js';
export * from './l3-kosmo-cd.js';
export * from './l3-kosmo-sm.js';
export * from './l3-kosmo-sme.js';

/** L3 — KOSMO 사업 규칙 20종 */
export const L3_RULES: readonly Rule[] = [
  ...KOSMO_AAS_RULES,
  ...KOSMO_SM_RULES,
  ...KOSMO_SME_RULES,
  ...KOSMO_CD_RULES,
  // 공정 단위 — 계층 서브모델이 있는 파일에만 걸린다(설비 파일은 그냥 지나간다)
  ...HIERARCHY_RULES,
];

/** 전체 규칙 */
export const ALL_RULES: readonly Rule[] = [...L1_RULES, ...L2_RULES, ...L3_RULES];

export { L1_RULES, L2_RULES };
