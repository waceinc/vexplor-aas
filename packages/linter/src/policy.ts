/**
 * 린터 정책.
 *
 * KTL 규정과 KOSMO Validator는 3군데에서 정면 충돌한다(명세 §5).
 * 린터는 이 충돌을 숨기지 않고 사용자가 고르게 하며, 어느 쪽을 골랐는지 findings에 남긴다.
 * 기본값은 2026-08-13 확정 방식 — Validator 통과 우선, 되돌릴 수 있는 형태로.
 */

export type IriConflictPolicy = 'kosmo-first' | 'idta-preserve';
export type CdDefinitionPolicy = 'require-en' | 'allow-empty';
export type LangTagPolicy = 'fix-when-evidence' | 'preserve';
/** AASd-120(SML 직계 자식 idShort 금지)을 어느 무게로 볼지 */
export type SmlChildIdShortPolicy = 'warn' | 'forbid' | 'allow';
/** IDTA·W3C 표준 용어를 가리키는 semanticId를 어떻게 볼지 */
export type StandardSemanticsPolicy = 'kosmo-first' | 'preserve';

export interface LinterPolicy {
  /**
   * 충돌 ① — KTL §4 주의1은 IDTA 공식 IRI 보존을 요구하나 KOSMO는 admin-shell.io IRI를 거부한다.
   *  kosmo-first  : 화이트리스트 밖 IRI를 error로 본다 (기본)
   *  idta-preserve: IDTA 공식 IRI는 통과시키고 warning으로만 표시한다
   */
  iriConflict: IriConflictPolicy;
  /**
   * 충돌 ② — KTL §8은 정의 없으면 공란 유지, KOSMO-CD-3은 영문 definition 필수.
   *  require-en : 영문 definition/description 없으면 error (기본)
   *  allow-empty: 공란을 허용하고 info로만 남긴다
   */
  cdDefinition: CdDefinitionPolicy;
  /**
   * 충돌 ③ — KTL §7은 IDTA 템플릿 오류도 원본 유지, 그러나 언어태그 오타는 AASd 위반을 부른다.
   *  fix-when-evidence: 중복 언어태그를 error로 보고 교정 대상으로 삼는다 (기본)
   *  preserve         : warning으로만 표시한다
   */
  langTagTypo: LangTagPolicy;
  /**
   * 충돌 ④ — **AASd-120**. 규격은 SubmodelElementList 직계 자식의 idShort를 금지하지만,
   * KOSMO Validator는 이를 검사하지 않는다(리포트 4회분에 없음). 반면 표준 도구는 강제한다:
   * `aas-test-engines` 1.0.3은 오류로 떨어뜨리고, `basyx-python-sdk`는 파일을 아예 읽지 못한다.
   *
   *  warn  : 경고 (기본) — KOSMO 제출은 막지 않되 상호운용이 깨진다는 사실을 알린다
   *  forbid: 위반 — BaSyx 적재·표준 도구 통과가 목표인 배포
   *  allow : 참고 — 알고도 두겠다는 선택
   */
  smlChildIdShort: SmlChildIdShortPolicy;
  /**
   * 충돌 ⑤ — **표준 템플릿의 용어**(2026-08-24 AID 도입 중 확인).
   *
   * IDTA 표준 서브모델 템플릿(AID 등)은 요소마다 W3C WoT·IDTA 용어를 semanticId로 갖는데,
   * **공식 템플릿에 ConceptDescription이 딸려 오지 않는다**(IDTA-02017 실측: CD 0개).
   * 그래서 KOSMO-SME-3("모든 semanticId에 대응 CD 필요")이 요소 수만큼 걸린다(실측 61건).
   * 「고치기」를 돌리면 위반은 사라지지만 **표준 용어가 자체 IRI로 덮여 템플릿의 의미가 깨진다.**
   * 한편 KTL 모델링 규칙 §7은 "IDTA 표준 템플릿은 원본 그대로 사용"을 요구한다 — 정면 충돌이다.
   *
   *  kosmo-first: 위반으로 본다 (기본). KOSMO 제출이 목표일 때
   *  preserve   : 표준 용어는 참고로만 남기고 교정하지 않는다. KTL §7과 상호운용을 지킬 때
   *
   * 🔴 KOSMO Validator가 AID를 실제로 어떻게 판정하는지는 **실측 자료가 없다.**
   * 제출 전에 반드시 확인하고, 정해지면 이 기본값을 바꾼다.
   */
  standardTemplateSemantics: StandardSemanticsPolicy;

  /** KOSMO가 인정하는 자체 IRI 접두 */
  iriBase: string;
  /** IRDI로 인정하는 접두 (eCl@ss 0173-, IEC CDD 0112/) */
  irdiPrefixes: string[];
  /**
   * 필수 서브모델 idShort. KOSMO-AAS-4.
   * 실측 기준으로 DigitalNameplate·HandoverDocumentation·TechnicalData·OperationalData 4종.
   */
  requiredSubmodels: string[];
  /** 서브모델 총 개수 허용 범위 (6종 이상 8종 이하 — 9종 이상은 위반) */
  submodelCountRange: [min: number, max: number];
  /**
   * Property value 존재 검사(KOSMO-SME-4)에서 제외할 서브모델 idShort.
   * DN·HD는 실제 값이 장비마다 달라 템플릿 단계에서 비어 있어도 통과시킨다.
   */
  valueCheckExemptSubmodels: string[];
}

export const DEFAULT_POLICY: LinterPolicy = {
  iriConflict: 'kosmo-first',
  cdDefinition: 'require-en',
  langTagTypo: 'fix-when-evidence',
  smlChildIdShort: 'warn',
  standardTemplateSemantics: 'kosmo-first',
  iriBase: 'https://www.smart-factory.kr/ids',
  irdiPrefixes: ['0173-', '0112/'],
  requiredSubmodels: [
    'DigitalNameplate',
    'HandoverDocumentation',
    'TechnicalData',
    'OperationalData',
  ],
  submodelCountRange: [6, 8],
  valueCheckExemptSubmodels: ['DigitalNameplate', 'HandoverDocumentation'],
};

/** IDTA 공식 IRI 접두 — 충돌 ①의 대상 */
export const IDTA_IRI_PREFIX = 'https://admin-shell.io/';

/**
 * 표준 용어 사전의 접두 — 우리가 ConceptDescription을 만들 대상이 아니다.
 * IDTA 서브모델 템플릿과 그것이 기반한 W3C WoT·schema.org 용어들.
 */
export const STANDARD_TERM_PREFIXES = [
  'https://admin-shell.io/idta/',
  'https://www.w3.org/',
  'http://www.w3.org/',
  'https://schema.org/',
  'http://schema.org/',
] as const;

export function isStandardTerm(value: string): boolean {
  return STANDARD_TERM_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function withPolicy(overrides: Partial<LinterPolicy> = {}): LinterPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}
