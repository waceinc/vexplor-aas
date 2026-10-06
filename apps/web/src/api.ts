/**
 * API 클라이언트.
 *
 * 서버 경로는 IDTA Part 2를 따른다(docs/spec/part2/). 식별자는 base64url로 인코딩해 넣는다.
 * 파일 해석은 전부 서버가 한다 — 브라우저는 바이트를 올리고 결과를 받을 뿐이다(기획서 Ⅷ).
 */
import type { ConceptDescription, Finding, Shell, Submodel } from './model.js';
import { tr, fill } from './i18n.js';

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

/** Part 2는 경로에 들어가는 id를 base64url로 인코딩하도록 정한다 */
export function encodeIdentifier(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 리비전이 어긋났을 때 — 다른 곳에서 먼저 바뀌었다는 뜻이다 */
export class ConflictError extends ApiError {}

/** 토큰이 없거나 틀렸다 (401) */
export class UnauthorizedError extends ApiError {}

/** 읽기 전용 토큰으로 고치려 했다 (403) */
export class ForbiddenError extends ApiError {}

/**
 * 접근 토큰.
 *
 * 서버가 인증을 켜고 있으면 모든 요청에 `Authorization: Bearer`로 붙는다.
 * 브라우저에 남겨 두는 이유는 새로고침마다 다시 묻지 않기 위해서다 —
 * 폐쇄망 공용 PC라면 「토큰 지우기」로 지운다.
 */
const TOKEN_KEY = 'aas.token';
let token: string | undefined = readStoredToken();

function readStoredToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // 사생활 보호 모드 등 — 없으면 없는 대로 쓴다
  }
}

export function setToken(value: string | undefined): void {
  token = value?.trim() || undefined;
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* 저장 못 해도 이번 세션은 동작한다 */
  }
}

export function currentToken(): string | undefined {
  return token;
}

/** 토큰을 얹은 헤더를 만든다 */
/**
 * 보내는 것 둘 — 세션 쿠키와 (있으면) API 키.
 *
 * 🔴 `credentials: 'same-origin'`은 fetch의 기본값이지만 **적어 둔다.** 로그인 세션이
 *    쿠키로만 오가므로, 누가 모르고 'omit'으로 바꾸면 로그인이 통째로 안 되고
 *    그 이유를 찾기 어렵다.
 * 🔴 세션 열쇠는 화면이 만지지 않는다 — HttpOnly라 스크립트가 읽을 수도 없다.
 */
function withAuth(init?: RequestInit): RequestInit {
  const base: RequestInit = { ...init, credentials: 'same-origin' };
  if (!token) return base;
  return {
    ...base,
    headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withAuth(init));
  if (!response.ok) {
    // 규격의 Result/Message 본문을 사람이 읽을 한 줄로 만든다
    let text = `${response.status} ${response.statusText}`;
    let fromApi = false;
    try {
      const body = (await response.json()) as { messages?: { text: string }[] };
      fromApi = true;
      if (body.messages?.[0]?.text) text = body.messages[0].text;
    } catch {
      /* 본문이 JSON이 아닐 수 있다 */
    }
    // 🔴 JSON이 아닌 5xx는 API가 낸 것이 아니다 — 그 앞(Vite 프록시·리버스 프록시)이 API에 닿지 못한 모습.
    //    「500 Internal Server Error」를 그대로 보이면 사람은 자기 파일이 잘못된 줄 안다
    if (!fromApi && response.status >= 500) {
      text = tr('API 서버에 연결할 수 없습니다 — 8080이 떠 있는지 확인하십시오 (개발: npm run dev:api).');
    }
    if (response.status === 409) throw new ConflictError(409, text);
    if (response.status === 401) throw new UnauthorizedError(401, text);
    if (response.status === 403) throw new ForbiddenError(403, text);
    throw new ApiError(response.status, text);
  }
  if (response.status === 204) return undefined as T;
  // 🔴 HTML이 왔다는 것은 API가 아니라 **화면 서버**가 답한 것이다(개발 프록시에 이 경로가 없을 때).
  //    「Unexpected token '<'」 원문을 사람에게 보이지 않는다 — 어디를 고칠지 말해 준다
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new ApiError(response.status, fill(tr('API 응답이 아닙니다 ({0}) — 개발 서버 프록시(vite.config.ts)에 이 경로가 빠져 있습니다.'), { 0: path }));
  }
  return (await response.json()) as T;
}

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
  user?: { id: string; login: string; displayName: string; role: 'admin' | 'editor' | 'viewer'; level: 'full' | 'read-only' };
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

const asJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  // ── 로그인 (2026-10-02) ──────────────────────────────────────────────────
  authMe: (): Promise<AuthState> => request('/auth/me'),
  login: (login: string, password: string): Promise<{ user: AuthState['user'] }> =>
    request('/auth/login', asJson({ login, password })),
  logout: (): Promise<void> => request('/auth/logout', { method: 'POST' }),
  setup: (
    login: string,
    password: string,
    displayName: string,
    setupCode?: string,
  ): Promise<{ user: AuthState['user'] }> =>
    request('/auth/setup', asJson({ login, password, displayName, setupCode })),
  signup: (
    login: string,
    password: string,
    displayName: string,
    email: string,
    company = '',
    agreed = false,
  ): Promise<{ user: AuthState['user'] }> =>
    request('/auth/signup', asJson({ login, password, displayName, email, company, agreed })),
  // ── 계정 관리(관리자) ──
  listUsers: (): Promise<{ result: UserView[] }> => request('/auth/users'),
  createUser: (user: { login: string; displayName: string; role: string; password: string }): Promise<unknown> =>
    request('/auth/users', asJson(user)),
  updateUser: (
    id: string,
    patch: { role?: string; disabled?: boolean; password?: string; displayName?: string },
  ): Promise<unknown> =>
    request(`/auth/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** 관리자가 남의 계정을 지운다 — 그 사람이 올린 파일도 함께. 되돌릴 수 없다 */
  deleteUser: (id: string): Promise<{ deleted: string; files: number }> =>
    request(`/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 탈퇴 — 내 계정을 지운다. 감사 기록의 「누가」는 남는다 */
  deleteMe: (): Promise<void> => request('/auth/me', { method: 'DELETE' }),
  changePassword: (current: string, next: string): Promise<unknown> =>
    request('/auth/password', asJson({ current, next })),

  listPackages: (): Promise<{ result: PackageDescription[] }> => request('/packages'),

  upload: (file: File): Promise<PackageDescription> =>
    request(`/packages?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }),

  remove: (packageId: string): Promise<void> =>
    request(`/packages/${packageId}`, { method: 'DELETE' }),

  submodels: (packageId: string): Promise<{ result: Submodel[] }> =>
    request(`/packages/${packageId}/api/v3.0/submodels?limit=1000`),

  lint: (packageId: string): Promise<LintReport> =>
    request(`/packages/${packageId}/lint?detail=true`),

  // 고칠 수 있는 경고(AASd-120 등)도 함께 — 파일마다 늘 「경고 1건」이 남아 있었다(2026-09-07)
  fix: (packageId: string, select?: { ruleId: string; pointer: string }[]): Promise<FixReport> =>
    request(
      `/packages/${packageId}/fix?includeWarnings=1`,
      select
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ select }) }
        : { method: 'POST' },
    ),
  /** 무엇을 어떻게 고칠지 — 저장하지 않고 계산만. 팝업이 항목별 전/후를 그린다 */
  fixPreview: (packageId: string): Promise<FixReport> => request(`/packages/${packageId}/fix-preview?includeWarnings=1`),
  /** IRI 이관 대장(새 IRI → 원본 IRI) — 파일 안 파트에 쌓인 것 */
  relocations: (packageId: string): Promise<{ relocations: Record<string, string> }> =>
    request(`/packages/${packageId}/relocations`),
  /** 원본 IRI로 되돌리기 — 규정 해석이 뒤집혔을 때 */
  revertRelocations: (
    packageId: string,
  ): Promise<{ reverted: { iri: string; original: string; how: string }[]; remaining: Record<string, string> }> =>
    request(`/packages/${packageId}/relocations/revert`, { method: 'POST' }),

  revisions: (
    packageId: string,
  ): Promise<{
    package: number;
    Submodel: Record<string, number>;
    AssetAdministrationShell: Record<string, number>;
  }> => request(`/packages/${packageId}/revisions`),

  /** AAS의 assetInformation 교체 — assetKind·globalAssetId가 여기 산다(KOSMO-AAS-5·6) */
  /**
   * 용어(CD) 정의 저장 — 규격의 PUT(통째 교체). 먼저 지금 판의 ETag를 읽어 If-Match로 보낸다.
   * CD는 revisions 목록에 없어서 이 방법으로 남의 편집을 덮어쓰지 않는다.
   */
  putConceptDescription: async (packageId: string, concept: Record<string, unknown>): Promise<void> => {
    const path = `/packages/${packageId}/api/v3.0/concept-descriptions/${encodeIdentifier(String(concept['id']))}`;
    const current = await fetch(path, withAuth());
    const etag = current.ok ? current.headers.get('etag') : null;
    await request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
      body: JSON.stringify(concept),
    });
  },

  putAssetInformation: (
    packageId: string,
    aasId: string,
    info: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}/asset-information`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(info),
      },
    ),

  /**
   * $value 수정 — A안에서 이 경로는 저작 편집이다(파일까지 남는다).
   * revision을 주면 If-Match로 보내 다른 사람이 먼저 고친 것을 덮어쓰지 않는다.
   */
  /** 되돌리기 스택 — 최근 것이 앞. 라벨은 사람 말("「SerialNumber」 지움") */
  undoStatus: (packageId: string): Promise<UndoStatus> => request(`/packages/${packageId}/undo`),
  /** 방금 변경을 되돌린다. 돌릴 것이 없으면 409 */
  undo: (packageId: string): Promise<UndoStatus & { undone: string }> =>
    request(`/packages/${packageId}/undo`, { method: 'POST' }),
  redo: (packageId: string): Promise<UndoStatus & { redone: string }> =>
    request(`/packages/${packageId}/redo`, { method: 'POST' }),

  /** 서브모델의 변경 이력 — 최신이 앞. 되돌리기의 재료다 */
  history: (
    packageId: string,
    submodelId: string,
  ): Promise<{ result: HistoryEntry[] }> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}`),

  /** 이력의 한 판으로 서브모델을 되돌린다 */
  restore: (packageId: string, submodelId: string, changedAt: string): Promise<void> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changedAt }),
    }),

  patchValue: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    value: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/$value`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(value),
      },
    ),

  policy: (packageId: string): Promise<Policy> => request(`/packages/${packageId}/policy`),

  /** 이 도구가 지키는 규칙과 규약 — 지금 도는 것을 그대로 받는다 */
  rules: (): Promise<RuleCatalog> => request('/rules'),

  /** 파일이 하나도 없을 때도 규약이 필요하다 — 첫 화면의 「새 설비 만들기」 */
  globalPolicy: (): Promise<Policy> => request('/policy'),

  /** 규칙대로 된 새 설비 뼈대를 만든다. 무엇이 들어가는지는 서버(린터 정책)가 정한다 */
  createPackage: (
    assetName: string,
    extraSubmodels: string[],
    unit: 'equipment' | 'composite' = 'equipment',
  ): Promise<PackageDescription> =>
    request('/packages/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetName, extraSubmodels, unit }),
    }),

  /**
   * 목록에서 파일 하나를 지운다.
   * 🔴 되돌릴 수 없다. 서버에 보관된 것이 사라지는 것이며, 내려받아 둔 .aasx는 남는다.
   */
  deletePackage: (packageId: string): Promise<void> =>
    request(`/packages/${packageId}`, { method: 'DELETE' }),

  /**
   * 대표 사진(썸네일) 올리기 — KOSMO-AAS-1의 그 파일이다.
   * 뼈대의 임시 그림을 실제 장비 사진으로 바꾸는 자리. 서버가 defaultThumbnail 경로와
   * 이전 파트 정리까지 처리한다.
   */
  putThumbnail: (packageId: string, shellId: string, file: File, revision?: number): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(shellId)}` +
        `/asset-information/thumbnail?fileName=${encodeURIComponent(file.name)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: file,
      },
    ),

  /** 공정의 계층을 읽는다. 설비 파일도 부품 계층을 갖고 있어 같은 자리에서 읽힌다 */
  hierarchy: (packageId: string): Promise<HierarchyView> =>
    request(`/packages/${packageId}/hierarchy`),

  /**
   * 설비를 매단다.
   * 🔴 `sourcePackageId`를 주면 이름과 Asset 주소를 **서버가 그 파일에서 읽는다** —
   *    사람이 옮겨 적다 틀리면 두 파일을 잇는 끈이 조용히 끊긴다.
   */
  addHierarchyNode: (
    packageId: string,
    input: {
      sourcePackageId?: string;
      name?: string;
      globalAssetId?: string;
      bulkCount?: number;
      /** 파일 없는 중간 마디(공정·그룹)를 만들 때 */
      group?: boolean;
      /** 어느 마디 밑에 넣을지 — 진입점부터의 이름 경로 */
      parentPath?: string[];
    },
  ): Promise<{ name: string; globalAssetId?: string }> =>
    request(`/packages/${packageId}/hierarchy/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  /**
   * 파일 복제 — 호기별로 나누기의 실체. 서브모델·첨부까지 통째로 복사하고
   * id는 새 이름으로 개명된 새 파일(packageId)을 돌려받는다.
   */
  clonePackage: (packageId: string, assetName: string): Promise<PackageDescription> =>
    request(`/packages/${packageId}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetName }),
    }),

  removeHierarchyNode: (packageId: string, name: string, parentPath: string[] = []): Promise<void> =>
    request(
      `/packages/${packageId}/hierarchy/nodes/${encodeURIComponent(name)}` +
        (parentPath.length > 0 ? `?parent=${encodeURIComponent(parentPath.join('/'))}` : ''),
      { method: 'DELETE' },
    ),

  shells: (packageId: string): Promise<{ result: Shell[] }> =>
    request(`/packages/${packageId}/api/v3.0/shells`),

  addSubmodelRef: (packageId: string, aasId: string, submodelId: string): Promise<unknown> =>
    request(`/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}/submodel-refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'ModelReference',
        keys: [{ type: 'Submodel', value: submodelId }],
      }),
    }),

  removeSubmodelRef: (packageId: string, aasId: string, submodelId: string): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}` +
        `/submodel-refs/${encodeIdentifier(submodelId)}`,
      { method: 'DELETE' },
    ),

  createSubmodel: (packageId: string, content: unknown): Promise<unknown> =>
    request(`/packages/${packageId}/api/v3.0/submodels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(content),
    }),

  deleteSubmodel: (packageId: string, submodelId: string): Promise<void> =>
    request(`/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}`, {
      method: 'DELETE',
    }),

  /** parentPath가 없으면 서브모델 바로 아래에 붙인다 */
  createElement: (
    packageId: string,
    submodelId: string,
    parentPath: string | undefined,
    content: unknown,
  ): Promise<unknown> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}/submodel-elements` +
        (parentPath ? `/${parentPath}` : ''),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(content),
      },
    ),

  deleteElement: (packageId: string, submodelId: string, idShortPath: string): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}`,
      { method: 'DELETE' },
    ),

  conceptDescriptions: (packageId: string): Promise<{ result: ConceptDescription[] }> =>
    request(`/packages/${packageId}/api/v3.0/concept-descriptions?limit=2000`),

  /** 요소 전체를 바꾼다 — semanticId처럼 $value로 못 고치는 것에 쓴다 */
  putElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    content: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(content),
      },
    ),

  /** 요소를 형제 안에서 옮긴다(규격 밖 연산). `{offset}` -1=위·1=아래 한 칸, `{to}` n번째 자리로 */
  moveElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    move: { offset: -1 | 1 } | { to: number },
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/move`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(move),
      },
    ),

  /** 요소를 바로 아래에 복제한다(규격 밖). 이름은 서버가 `X_2`로 짓는다 */
  duplicateElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    revision?: number,
  ): Promise<{ idShort?: string }> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/duplicate`,
      {
        method: 'POST',
        headers: revision === undefined ? {} : { 'if-match': String(revision) },
      },
    ),

  /**
   * 첨부 올리기 — File·Blob 요소가 가리키는 **실제 파일**(매뉴얼 PDF·도면 등).
   *
   * 서버가 패키지 안에 파트를 만들고 `File.value`까지 함께 고친다. 브라우저는 바이트만 올린다.
   * 🔴 파일명은 질의 인자로 준다 — 본문은 파일 바이트 그대로여야 하기 때문이다.
   */
  /**
   * 가이던스에 붙일 UML 다이어그램(SVG 문자열).
   * `submodel`을 주지 않으면 AAS 전체 구성도.
   */
  diagram: async (packageId: string, submodel?: string): Promise<string> => {
    const query = submodel ? `?submodel=${encodeURIComponent(submodel)}` : '';
    const response = await fetch(`/packages/${packageId}/diagram.svg${query}`, withAuth());
    if (!response.ok) throw await toError(response);
    return await response.text();
  },

  /** 서브모델별로 표를 만들지 정보를 적을지 (규정 §13 주의사항 5) */
  docPlan: (packageId: string): Promise<{ result: DocPlan[] }> =>
    request(`/packages/${packageId}/doc-plan`),

  /** 상세 정보 테이블(화면용). 표 대상이 아니면 info가 온다 */
  table: (
    packageId: string,
    submodel: string,
  ): Promise<{
    plan: DocPlan;
    rows?: TableRow[];
    tables?: SmtTable[];
    info?: SubmodelInfo;
    tableCount?: number;
  }> =>
    request(`/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}`),

  /** 붙여넣기용 HTML 표. `from`은 표 번호 시작값(문서 전체에서 이어져야 한다) */
  tableHtml: async (packageId: string, submodel: string, from?: number): Promise<string> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=html` +
        (from === undefined ? '' : `&from=${from}`),
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    return await response.text();
  },

  downloadTableCsv: async (packageId: string, submodel: string): Promise<void> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=csv`,
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? `${submodel}.csv`);
  },

  putAttachment: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    file: File,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment?fileName=${encodeURIComponent(file.name)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: file,
      },
    ),

  deleteAttachment: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    revision?: number,
  ): Promise<unknown> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment`,
      {
        method: 'DELETE',
        ...(revision === undefined ? {} : { headers: { 'if-match': String(revision) } }),
      },
    ),

  /** 붙어 있는 첨부를 내려받는다. 링크가 아니라 fetch로 가져온다(토큰 때문) */
  downloadAttachment: async (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    filename: string,
  ): Promise<void> => {
    const response = await fetch(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment`,
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filename);
  },

  /** 서브모델 부분 갱신 — 이름(idShort) 바꾸기에 쓴다 */
  patchSubmodel: (
    packageId: string,
    submodelId: string,
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<void> =>
    request(`/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(revision === undefined ? {} : { 'if-match': String(revision) }),
      },
      body: JSON.stringify(patch),
    }),

  importSubmodel: (
    packageId: string,
    sourcePackageId: string,
    submodelId: string,
    /** 같은 idShort가 이미 있을 때 — 기본은 거절(409) */
    onDuplicate: 'reject' | 'replace' | 'alongside' = 'reject',
  ): Promise<{
    submodelId: string;
    renamedFrom?: string;
    copiedConceptDescriptions: number;
    replaced?: string[];
    idShort?: string;
  }> =>
    request(`/packages/${packageId}/import-submodel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePackageId, submodelId, onDuplicate }),
    }),

  interfaces: (packageId: string): Promise<{ source: string; interfaces: AidInterfaceView[] }> =>
    request(`/packages/${packageId}/interfaces`),

  values: (packageId: string, limit = 200): Promise<{ result: CollectedValueView[] }> =>
    request(`/packages/${packageId}/values?limit=${limit}`),

  /**
   * 수집값이 모델의 어느 요소에 얹히는지 — 연결 상태 점검.
   * BaSyx DataBridge와 달리 우리는 모델에 되쓰지 않으므로, **이름이 맞는지**가 관건이다.
   */
  liveMapping: (
    packageId: string,
  ): Promise<LiveMapping> => request(`/packages/${packageId}/live`),

  /**
   * 수집 연결(AID) 만들기 — 접속 주소와 태그 목록으로 규격대로 짓는다.
   * 응답의 nameMisses는 모델 요소와 이름이 안 맞는 태그다(live 내보내기가 안 되는 것).
   */
  createAid: (
    packageId: string,
    input: {
      endpoint: string;
      title?: string;
      tags: { name: string; href: string; key?: string; type?: string; unit?: string }[];
      /** 모델에 없는 태그의 자리를 OperationalData에 함께 세운다. 없으면 만들지 않는다 */
      createMissing?: { group: string; subgroup: string };
    },
  ): Promise<{
    submodelId: string;
    replaced: boolean;
    nameMatches: number;
    nameMisses: string[];
    elementsAdded: string[];
    /** 다른 서브모델에 같은 이름이 있어 만들지 않은 것 — 만들면 값이 어디에도 안 얹힌다 */
    elementsConflicted?: string[];
  }> =>
    request(`/packages/${packageId}/aid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  /** 자동 수집 상태 — 돌고는 있는 건가 */
  collectStatus: (): Promise<{
    /** 수집(과 가상 PLC)을 쓸 수 있는 서버인가 */
    collect?: boolean;
    running: boolean;
    intervalMs?: number;
    sweeping?: boolean;
    reason?: string;
    lastSweep?: {
      startedAt: string;
      collected: number;
      packages: number;
      results?: { packageId: string; collected: number; errors: string[] }[];
    };
  }> => request('/collect-status'),

  /**
   * 설비를 훑어 태그 목록을 가져온다 — NodeId를 손으로 치지 않게 하는 자리.
   * 못 붙으면 502와 사유가 온다.
   */
  browseDevice: (
    endpoint: string,
  ): Promise<{
    endpoint: string;
    truncated: boolean;
    nodes: {
      nodeId: string;
      name: string;
      path: string;
      type: 'float' | 'integer' | 'boolean' | 'string';
      value?: string;
      error?: string;
    }[];
  }> =>
    request('/opcua/browse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }),

  /**
   * OPC UA 노출 상태(M6·M7) — 우리가 지금 밖으로 무엇을 내주고 있는가.
   * 꺼져 있으면 running:false와 사유가 온다(오류가 아니다).
   */
  opcuaStatus: (): Promise<{
    running: boolean;
    endpoint?: string;
    packages: number;
    variables: number;
    lastRefresh?: string;
    lastError?: string;
    reason?: string;
  }> => request('/opcua-status'),

  /** 지금 한 번 수집한다. 수집 어댑터가 없는 배포에서는 501이 온다 */
  collect: (packageId: string): Promise<CycleReportView> =>
    request(`/packages/${packageId}/collect`, { method: 'POST' }),

  /**
   * 내려받기·결과서는 링크가 아니라 fetch로 가져온다.
   * `<a href>`에는 헤더를 실을 수 없어 인증을 켜면 401이 나고, 토큰을 주소에 넣으면
   * 서버 로그와 브라우저 기록에 그대로 남는다.
   */
  download: async (packageId: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? 'download.aasx');
  },

  /** 레퍼런스 번들 — 구성·준비 상태·연계 항목 */
  bundle: (packageId: string, evidenceMinutes = ''): Promise<BundleView> =>
    request(`/packages/${packageId}/bundle/linkage${evidenceMinutes ? `?evidenceMinutes=${evidenceMinutes}` : ''}`),

  /** 번들 첨부 올리기 — 경로는 폴더/파일이름 */
  putBundleFile: (packageId: string, path: string, file: Blob): Promise<void> =>
    request(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }),

  deleteBundleFile: (packageId: string, path: string): Promise<void> =>
    request(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),

  downloadBundleFile: async (packageId: string, path: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), path.split('/').pop() ?? 'attachment');
  },

  /** 내장 가상 PLC(시뮬레이션)에 이 설비를 붙이고 수집 연결을 만든다 */
  simulate: (packageId: string): Promise<{ machine: string; endpoint: string; title: string; tags: number }> =>
    request(`/packages/${packageId}/simulate`, { method: 'POST' }),

  downloadBundle: async (
    packageId: string,
    options: { code: string; title: string; version: string; evidence: string; evidenceMinutes?: string },
  ): Promise<void> => {
    const { evidenceMinutes, ...rest } = options;
    const query = new URLSearchParams({ ...rest, ...(evidenceMinutes ? { evidenceMinutes } : {}) }).toString();
    const response = await fetch(`/packages/${packageId}/bundle?${query}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? `bundle-${options.code}.zip`);
  },

  /** 번들 ZIP을 연다 — 공정·설비가 한 번에 올라오고 해시를 대조한다 */
  openBundle: (file: File): Promise<BundleImportView> =>
    request('/bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    }),

  openReport: async (packageId: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}/report`, withAuth());
    if (!response.ok) throw await toError(response);
    const url = URL.createObjectURL(await response.blob());
    globalThis.open(url, '_blank', 'noreferrer');
    // 새 탭이 다 읽고 나서 놓아 준다
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

async function toError(response: Response): Promise<ApiError> {
  let text = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { messages?: { text: string }[] };
    if (body.messages?.[0]?.text) text = body.messages[0].text;
  } catch {
    /* 본문이 JSON이 아닐 수 있다 */
  }
  if (response.status === 401) return new UnauthorizedError(401, text);
  if (response.status === 403) return new ForbiddenError(403, text);
  return new ApiError(response.status, text);
}

/** content-disposition의 filename*(UTF-8)을 먼저 본다 — 한글 파일명이 여기 산다 */
function filenameOf(response: Response): string | undefined {
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="([^"]+)"/i.exec(disposition)?.[1];
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
