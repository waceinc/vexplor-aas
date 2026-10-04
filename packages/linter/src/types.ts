/**
 * 린터 공통 타입.
 *
 * 리포트 구조는 KOSMO Validator의 에러 로그 3토막을 그대로 따른다(린터 명세 §7).
 *   The {elementType} "{key}" violates the Kosmo rules: @ {kosmoPath}
 *   - {message}      ← 무엇이 문제인지
 *   - {remedy}       ← 어떻게 고치라는 지시
 * 단, AASc-3a 계열에서 key를 출력하지 않는 KOSMO의 결함은 개선한다 — 우리는 항상 key를 채운다.
 */
import type { Environment, IdentifiableIndex, VisitedNode } from '@aas/core';
import type { LinterPolicy } from './policy.js';

/** 검사 계층 — 셋을 모두 구현해야 새는 구멍이 없다(명세 §0) */
export type Layer = 'L1' | 'L2' | 'L3';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  layer: Layer;
  severity: Severity;
  /** 위반 요소의 modelType. 예: 'SubmodelElementCollection' */
  elementType: string;
  /** 리포트 첫 토막에 강조되는 식별자(대개 idShort, 없으면 id) */
  key: string;
  /** RFC 6901 JSON Pointer */
  pointer: string;
  /** KOSMO 리포트 형식 경로. 예: /submodels/3(OperationalData)/submodelElements/0 */
  kosmoPath: string;
  /** 무엇이 문제인지 */
  message: string;
  /** 어떻게 고치라는 지시 */
  remedy?: string;
  /** 자동수정(Quick Fix) 가능 여부 */
  fixable: boolean;
  /** 정책 선택에 따라 결과가 달라지는 규칙이면 그 사유를 남긴다(명세 §5 충돌 3건) */
  policyNote?: string;
}

/** 규칙이 결과를 보고할 때 쓰는 함수. ruleId·layer는 엔진이 채운다 */
export type Report = (finding: Omit<Finding, 'ruleId' | 'layer'>) => void;

/** 패키지 수준 검사(L1)에 필요한 정보. AASX 없이 Environment만 린트할 때는 생략된다 */
export interface PackageContext {
  /** ZIP에 실재하는 절대 파트명 목록 */
  parts: string[];
  /** [Content_Types].xml Override에 선언된 파트명 */
  contentTypeOverrides: string[];
  /**
   * [Content_Types].xml Default에 선언된 확장자(소문자). OPC 규격상 Default도 유효한 선언이다.
   * 예전 호출자와 맞추려고 선택 항목으로 둔다
   */
  contentTypeDefaults?: string[];
  /** _rels/.rels 등 관계에서 참조하는 파트명 */
  relationshipTargets: string[];
}

export interface LintContext {
  environment: Environment;
  policy: LinterPolicy;
  /** id → Identifiable 색인 */
  index: IdentifiableIndex;
  /** 전체 SubmodelElement 순회 결과 (전수 수집 후 일괄 보고 — 명세 §6-4) */
  elements: VisitedNode[];
  package?: PackageContext;
}

export interface Rule {
  id: string;
  layer: Layer;
  /** 한 줄 설명. 리포트 요약과 규칙 목록에 쓴다 */
  title: string;
  /** 근거 문서 위치 */
  source: string;
  check(ctx: LintContext, report: Report): void;
}

export interface LintResult {
  findings: Finding[];
  /** 규칙 ID → 위반 건수 */
  countByRule: Record<string, number>;
  countBySeverity: Record<Severity, number>;
  countByLayer: Record<Layer, number>;
  /** error가 1건이라도 있으면 false */
  passed: boolean;
  /** 실행한 규칙 수 */
  rulesRun: number;
}
