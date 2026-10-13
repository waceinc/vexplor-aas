/**
 * 모델 — AAS 노드와 화면 트리의 모양 · 시각 표시.
 * src/model.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 model.ts 로 쓴다.
 */


export interface Finding {
  ruleId: string;
  layer: string;
  severity: 'error' | 'warning' | 'info';
  elementType: string;
  key: string;
  pointer: string;
  kosmoPath: string;
  message: string;
  remedy?: string;
  fixable: boolean;
  policyNote?: string;
}

export interface AasNode {
  modelType: string;
  idShort?: string;
  value?: unknown;
  statements?: AasNode[];
  annotations?: AasNode[];
  valueType?: string;
  [key: string]: unknown;
}

export interface Submodel extends AasNode {
  id: string;
  submodelElements?: AasNode[];
}

export interface Shell extends AasNode {
  id: string;
  assetInformation?: Record<string, unknown>;
}

export interface ConceptDescription extends AasNode {
  id: string;
}

export interface Environment {
  shells: readonly Shell[];
  submodels: readonly Submodel[];
  conceptDescriptions: readonly ConceptDescription[];
}

/**
 * ISO 시각 → 이 PC 시간대의 `YYYY-MM-DD HH:mm:ss`.
 * 🔴 수집 표·주소 목록 CSV·이력이 UTC를 그대로 찍고 있었다(서울 10:35에 「01:35」 — 2026-09-10 실측).
 *    검증 결과서는 2026-09-04에 현지 시각으로 고쳤는데 화면 쪽이 남아 있었다
 */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface TreeNode {
  /** React key이자 펼침 상태의 식별자 */
  key: string;
  label: string;
  modelType: string;
  /** Environment JSON Pointer — 린터 finding과 맞댄다 */
  pointer: string;
  /** Part 2 idShortPath. Submodel 자신은 undefined */
  idShortPath?: string;
  submodelId: string;
  depth: number;
  children: TreeNode[];
  node: AasNode;
  /**
   * 다른 파일에서 읽어 온 **보기 전용** 가지인가(공정 트리의 설비).
   * 파일 구조는 참조형 그대로다 — 화면에서만 이어 붙인 것이라 편집 대상이 아니다.
   */
  linkedPackageId?: string;
  /** ⚙ 가지 중 공정·라인(파일 없는 층) — ▦로 그린다 */
  linkedGroup?: boolean;
  /** 설비의 부품(BoM) — 파일도 동작도 없다. 설비(⚙)와 헷갈리지 않게 흐리게, 종류는 Part */
  linkedPart?: boolean;
  /** 설비 밑 부품을 접어 두는 「BOM (n)」 줄 */
  linkedPartGroup?: boolean;
  /**
   * 종류(영문 규격명) 옆에 붙는 우리말 한 줄 — 초보자가 "이건 뭔가"를 묻던 자리에만 단다.
   * 지금은 HierarchicalStructures 서브모델뿐: 회사 파일에서는 「회사·공정 구성도」, 설비 파일에서는 「부품 구성 (BOM)」
   * (사용자 2026-09-09 "괄호 안 문구를 바꿔서 초보자도 구분할 수 있게"). 종류명 자체는 규격 원문 그대로 둔다
   */
  typeNote?: string;
  /** typeNote에 마우스를 올리면 나오는 긴 설명 */
  typeTitle?: string;
}
