/**
 * API 클라이언트 — 레퍼런스 번들 · 문서용 자료 · 규칙 목록의 모양(타입).
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화). api/types.ts 가 다시 내보낸다.
 */

/** 레퍼런스 번들 — 공정에 묶인 설비 하나의 준비 상태 */
export interface BundleMemberView {
  name: string;
  globalAssetId: string;
  bulkCount: number;
  groupPath: string[];
  packageId?: string;
  fileName?: string;
  version?: string;
  /** aasd120 — 표준 검증기(aas-test-engines)는 오류로 보는 AASd-120 건수. KOSMO는 안 본다 */
  lint?: { passed: boolean; error: number; warning: number; aasd120?: number };
  /** 수집 연결(AID)이 붙은 시연본 */
  demo?: { login: string; password: string };
}

export interface LinkPointView {
  member: string;
  path: string;
  idShort: string;
  semanticId: string;
  valueType?: string;
  unit?: string;
}

export interface LinkageItemView {
  semanticId: string;
  label: string;
  names: string[];
  preferredName?: string;
  unit?: string;
  points: Record<string, LinkPointView[]>;
  coverage: number;
}

export interface LinkageFindingView {
  kind: 'shared-semantic' | 'split-semantic';
  severity: 'warning' | 'info';
  message: string;
  semanticIds: string[];
  names: string[];
}

/** 실동작 증빙 — 설비(형식) 자신이나 거기서 파생된 호기의 수집 기록 요약 */
export interface EvidenceSourceView {
  model: string;
  instance: string;
  direct: boolean;
  interfaces: { title: string; endpoint: string; simulated: boolean }[];
  from: string;
  to: string;
  samples: number;
  properties: number;
  truncated?: boolean;
}

export type EvidenceLevel = 'A' | 'B' | 'C';

export interface BundleView {
  process: { name: string; fileName: string };
  categories: Record<string, string>;
  members: BundleMemberView[];
  linkage: { members: string[]; missing: string[]; items: LinkageItemView[]; findings: LinkageFindingView[] };
  evidence: {
    suggested: EvidenceLevel | null;
    levels: Record<EvidenceLevel, string>;
    sources: EvidenceSourceView[];
    /** 번들을 열 때 이어받은 이전 증빙 — 새 수집이 없으면 이것이 실린다 */
    carried?: {
      level: string | null;
      entries: EvidenceSourceView[];
      from: { code?: string; version?: string; createdAt?: string };
    };
  };
  /** 사람이 넣은 문서·증빙 — 다시 내보내도 보존된다 */
  attachments: { path: string; size: number }[];
  attachmentFolders: string[];
}

export interface BundleImportView {
  bundle: { code?: string; title?: string; version?: string };
  processPackageId?: string;
  files: { file: string; packageId: string; hashOk: boolean | null; reused: boolean }[];
  problems: string[];
}

/** 규칙·규약 카탈로그 — 판정 근거를 보여 주는 자료 */
export interface RuleCatalog {
  rules: { id: string; layer: string; title: string; source: string; fixable: boolean }[];
  layers: { layer: string; title: string; meaning: string; count: number }[];
  conflicts: {
    key: string;
    title: string;
    conflict: string;
    choices: { value: string; meaning: string }[];
    current: string;
  }[];
  conventions: { key: string; title: string; value: string; source: string }[];
  verdict: { who: string; role: string }[];
  sources: { key: string; from: string }[];
}

/** 서브모델별 문서 자료 계획 (규정 §13 주의사항 5) */
export interface DocPlan {
  idShort: string;
  kind: 'table' | 'info';
  reason: string;
}

export interface TableRow {
  depth: number;
  path: string;
  idShort: string;
  modelType: string;
  dataType: string;
  unit: string;
  example: string;
  semanticId: string;
  description: string;
}

/** 실제 가이던스가 쓰는 IDTA SMT 표 (규정 §13 주의사항 5) */
export interface SemanticCell {
  idType: string;
  id: string;
  definition: string;
  korean: string;
  idtaOrigin: string;
}

export interface SmtChildRow {
  label: string;
  semantic: SemanticCell;
  value: string;
  cardinality: string;
}

export interface SmtTable {
  idShort: string;
  className: string;
  semantic: SemanticCell;
  parent: string;
  explanation: string;
  children: SmtChildRow[];
}

export interface SubmodelInfo {
  idShort: string;
  externalTemplate: string;
  dictionaries: string[];
  templateLink: string;
  elementCount: number;
  toWrite: string[];
}
