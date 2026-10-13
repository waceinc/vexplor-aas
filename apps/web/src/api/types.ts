/**
 * API 클라이언트 — 서버가 주고받는 모양(타입).
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { Finding } from '../model.js';

export interface PackageDescription {
  packageId: string;
  aasIds: string[];
  name?: string;
  /** AAS의 idShort — 파일명만으로는 무슨 설비인지 모른다 */
  assetName?: string;
  globalAssetId?: string;
  /** 공정(묶음) 파일이면 …/type/* */
  assetType?: string;
  revision?: number;
  updatedAt?: string;
  warnings?: string[];
}

/** 공정의 계층 — 무엇으로 이루어졌는가 */
/** 변경 이력 한 줄 — 그때의 내용 전체를 들고 있다 */
export interface UndoStatus {
  /** 되돌릴 수 있는 변경들 — 최근 것이 앞 */
  undo: string[];
  redo: string[];
}

export interface HistoryEntry {
  changedAt: string;
  operation: 'update' | 'delete';
  revision: number;
  /** 사람이 훑을 요약 — 그때의 요소 수 */
  elementCount: number;
  /**
   * 누가 바꿨나. **없을 수 있다** — 로그인을 쓰지 않는 서버이거나
   * 감사 기록을 들이기 전(2026-10-02)에 쌓인 이력이다.
   */
  actorName?: string;
}

/** 계층 한 마디 — 중첩. 그룹(중간 마디)은 globalAssetId가 비어 있다 */
export interface HierarchyNode {
  name: string;
  globalAssetId: string;
  bulkCount: number;
  children: HierarchyNode[];
}

/** 계층 — 회사>공정>장비를 한 파일 안에 담을 수 있다 */
export interface HierarchyView {
  entryNode: { name: string; globalAssetId: string } | null;
  children: HierarchyNode[];
}

export interface LintReport {
  passed: boolean;
  countBySeverity: { error: number; warning: number; info: number };
  countByRule: Record<string, number>;
  rulesRun: number;
  findings: Finding[];
}

/** AID가 기술한 인터페이스 (M8) */
export interface AidInterfaceView {
  name: string;
  title?: string;
  protocol: string;
  base?: string;
  properties: {
    name: string;
    key?: string;
    type?: string;
    unit?: string;
    href?: string;
    observable: boolean;
  }[];
}

export interface CollectedValueView {
  interfaceName: string;
  propertyName: string;
  source?: string;
  observedAt: string;
  /** 이 도구가 실제로 읽어 온 시각 — 신선도(받는 중 · 끊김)의 근거. 옛 기록에는 없다(그때는 observedAt) */
  receivedAt?: string;
  valueNumber?: number;
  valueText?: string;
  quality?: string;
}

export interface LiveMapping {
  collected: number;
  applied: number;
  notes: { propertyName: string; outcome: 'applied' | 'ambiguous' | 'unmatched'; paths: string[] }[];
}

export interface CycleReportView {
  startedAt: string;
  collected: number;
  interfaces: {
    name: string;
    error?: string;
    report?: {
      failures: { propertyName: string; reason: string }[];
      /**
       * 🔴 **아직 값이 안 들어온 것** — 실패와 다르다. 산출물이 형식(Type)이라 빈 값이 정상이고,
       *    설비도 초기화 전에는 값을 안 준다. 이걸 실패로 세면 「나쁜 태그 60」이 떠서
       *    설비가 고장 난 줄 안다. 비면 서버가 아예 안 실어 보낸다(옛 서버와도 어긋나지 않는다).
       */
      pending?: { propertyName: string; reason: string }[];
    };
  }[];
}

export interface FixReport {
  applied: { ruleId: string; pointer: string; key?: string; elementType?: string; description: string; before?: unknown; after?: unknown }[];
  skipped: { ruleId: string; pointer: string; reason: string }[];
  /** 이번 교정에서 옮긴 IRI(새 → 원본) */
  relocations: Record<string, string>;
  /** 파일에 쌓인 이관 대장 전체 — 반영(POST)에만 온다 */
  ledger?: Record<string, string>;
  rounds: number;
  before: LintReport;
  after: LintReport;
}

/** 린터 정책 — 새 id를 만들 때 쓴다. 규약은 서버(린터)에만 둔다 */
export interface Policy {
  iriBase: string;
  irdiPrefixes: string[];
  requiredSubmodels: string[];
}

/** 로그인 상태 — 화면이 가장 먼저 묻는 것 */
export interface AuthState {
  authenticated: boolean;
  /** 계정이 하나도 없다 — 첫 관리자를 만들어야 한다 */
  setupNeeded: boolean;
  /** 이 서버가 로그인(또는 API 키)을 요구하나. 꺼져 있으면 로그인 화면을 띄우지 않는다 */
  authRequired: boolean;
  /**
   * 첫 관리자를 만들 때 **설치 코드**를 물어야 하나 — 밖으로 열린 서버에서만 참이다.
   * 아무나 먼저 관리자가 되는 것을 막는 장치다(서버의 기동 로그에 적혀 있다).
   */
  setupCodeRequired?: boolean;
  /** 스스로 가입할 수 있는 서버인가 — 로그인 화면이 「회원가입」을 보일지 정한다 */
  signupAllowed?: boolean;
  /**
   * 개인정보처리방침 주소. **없으면 서버가 연락처를 받지 않는다** —
   * 화면도 연락처 칸을 보이지 않는다(어떻게 쓰는지 못 밝히면 받지 않는다).
   */
  privacyUrl?: string;
  /**
   * 체험판인가. 참이면 화면이 띠를 띄우고 **내려받기 단추를 감춘다** —
   * 눌러서 403을 보여 주는 것보다 처음부터 「가입하면 됩니다」라고 말하는 쪽이 낫다.
   */
  demo?: { login: string; password: string };
  user?: { id: string; login: string; displayName: string; role: 'admin' | 'editor' | 'viewer'; level: 'full' | 'read-only'; email?: string; company?: string };
}

/** 계정 관리 화면의 한 줄 */
export interface UserView {
  id: string;
  login: string;
  displayName: string;
  role: 'admin' | 'editor' | 'viewer';
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
  /** 가입 때 받은 것 — 관리자에게만 온다 */
  email?: string;
  company?: string;
  consentAt?: string;
  /** 체험 계정(공개 서버) — 지우거나 잠그지 못한다 */
  demo?: boolean;
}

export * from './bundleDocTypes.js';
