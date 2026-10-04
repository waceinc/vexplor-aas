/**
 * 자동수정(Quick Fix) 타입.
 *
 * 여러 파일 일괄 교정이 아니라 저작 UI에서 지적 한 건을 고치는 단위로 설계한다.
 * 되돌릴 수 있어야 하므로 무엇을 무엇으로 바꿨는지 전부 기록한다 —
 * 이 되돌리기 가능성이 Package Explorer에 없는 기능이자, 규정 해석이 뒤집혔을 때의 방어선이다.
 */
import type { Environment } from '@aas/core';
import type { LinterPolicy } from '../policy.js';
import type { Finding, PackageContext } from '../types.js';

export interface AppliedFix {
  ruleId: string;
  pointer: string;
  /** 지적이 가리키던 요소 이름(idShort 등) — 미리보기 표에서 "무엇을" 고치는지 사람이 읽는 칸 */
  key?: string;
  elementType?: string;
  /** 사람이 읽을 변경 설명 */
  description: string;
  before?: unknown;
  after?: unknown;
}

/** 교정 하나를 가리키는 열쇠 — 미리보기에서 고른 것만 반영할 때 쓴다 */
export interface FixSelector {
  ruleId: string;
  pointer: string;
}

export interface SkippedFix {
  ruleId: string;
  pointer: string;
  reason: string;
}

/**
 * IRI 이관 대장 — 신규 IRI를 키로, 원래 IRI를 값으로 담는다.
 * 실제 작업에서 167종을 이렇게 기록해 즉시 원복 가능한 상태로 유지했다.
 */
export type RelocationLedger = Record<string, string>;

export interface FixResult {
  /** 교정이 적용된 새 Environment (입력은 변경하지 않는다) */
  environment: Environment;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  relocations: RelocationLedger;
  /** lint → fix를 몇 번 반복했는지 */
  rounds: number;
}

export interface FixInput {
  /** 변경 대상. fixer는 이 객체를 직접 수정한다 */
  environment: Environment;
  finding: Finding;
  policy: LinterPolicy;
  package?: PackageContext;
  ledger: RelocationLedger;
}

export type FixOutcome =
  | { status: 'applied'; description: string; before?: unknown; after?: unknown }
  | { status: 'skipped'; reason: string };

export type Fixer = (input: FixInput) => FixOutcome;
