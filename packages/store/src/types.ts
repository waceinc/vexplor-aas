/**
 * 저장소 계약 — 기획서 M1.
 *
 * 값 동기화 정책 **A안(파일이 원본)** 이 이 설계를 결정한다(docs/PROGRESS.md §2-2).
 *  - Identifiable은 **원본 JSON을 통째로** 보관한다. 조회용 컬럼은 파생일 뿐이고, 어긋나면 원본이 이긴다.
 *  - 패키지의 썸네일·첨부·기타 파트를 함께 보관한다. 이게 없으면 export가 무손실이 아니다.
 *  - 배열 순서(ordinal)를 보존한다. 순서가 바뀌면 왕복이 원본과 달라진다.
 *
 * 그리고 하나 더 — **결함 있는 파일도 손실 없이 받는다.**
 * 저장소가 유효성을 강제하면 린터(M5)가 지적할 대상 자체가 들어오지 못한다.
 * 그래서 id에 UNIQUE를 걸지 않는다(KOSMO-CD-5 중복 id는 실측 결함이다).
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';

export type IdentifiableModelType =
  | 'AssetAdministrationShell'
  | 'Submodel'
  | 'ConceptDescription';

export const IDENTIFIABLE_MODEL_TYPES: readonly IdentifiableModelType[] = [
  'AssetAdministrationShell',
  'Submodel',
  'ConceptDescription',
];

/** Environment의 어느 배열에 담기는지 — 무손실 왕복의 기준 */
export const ENVIRONMENT_FIELD: Record<IdentifiableModelType, keyof Environment> = {
  AssetAdministrationShell: 'assetAdministrationShells',
  Submodel: 'submodels',
  ConceptDescription: 'conceptDescriptions',
};

/** AASX 파일 하나에 대응하는 작업 단위 */
export interface PackageRecord {
  id: string;
  /** 원본 파일명 — 사람이 알아보는 이름 */
  name: string;
  /** AAS 본문 파트명. 기본 /aasx/data.json */
  specPart: string;
  /** 낙관적 잠금용. 소속 Identifiable이 바뀔 때마다 오른다 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 주인 — 어느 작업 공간의 것인가(2026-10-04).
   *
   * **없으면 「공용」이다.** 팀이 같이 쓰는 서버(기본)에서는 아무 패키지에도 주인이 없고,
   * 모두가 전부를 본다 — 이 필드가 생기기 전과 똑같이 돈다.
   * 작업 공간을 나누는 서버(체험판)에서는 올린 사람의 열쇠가 적히고 그 사람만 본다.
   * 그때도 주인 없는 것(기동 때 올린 템플릿)은 누구나 **읽을 수는** 있다(scoped.ts).
   */
  owner?: string;
}

/**
 * - thumbnail · supplementary · extra — AASX 안의 파트다. 내보내면 그대로 AASX에 들어간다
 * - **bundle** — 레퍼런스 번들에 딸린 문서·증빙(Use-Case·가이던스·수집 기록…). 🔴 AASX에는 **넣지 않는다.**
 *   공정 파일의 해시가 바뀌면 번들 대조가 깨진다. 번들을 다시 내보낼 때 되살리려고 보관만 한다(2026-09-30)
 */
export type PackageFileRole = 'thumbnail' | 'supplementary' | 'extra' | 'bundle';

/** 무손실 export에 필요한 비(非)모델 파트 */
export interface PackageFileRecord {
  part: string;
  role: PackageFileRole;
  contentType: string;
  data: Uint8Array;
}

export interface IdentifiableRecord {
  /** 저장소 내부 키. id 중복 결함도 담아야 하므로 id와 별개로 둔다 */
  uid: string;
  packageId: string;
  modelType: IdentifiableModelType;
  id: string;
  idShort?: string;
  /** semanticId 첫 키 값 — 조회 편의를 위한 파생 컬럼 */
  semanticId?: string;
  /** AAS의 assetInformation.assetKind */
  assetKind?: string;
  /** Submodel의 kind */
  kind?: string;
  /** Environment 배열 안에서의 원래 순서 */
  ordinal: number;
  /** 원본 JSON 그대로 */
  content: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}

/**
 * 수집값 — 기획서 M8 · Phase 5.
 *
 * 🔴 값 동기화 **A안**: 이 값들은 **모델로 되돌아가지 않는다.** 모델 테이블을 참조만 하고
 * 반대 방향은 없다. 산출물이 Type/Template이라 런타임 값을 되쓰면 메타모델 의미 위반이다.
 */
export interface CollectedValue {
  packageId: string;
  /** AID 인터페이스 이름 */
  interfaceName: string;
  /** AID property 이름 */
  propertyName: string;
  /** 읽어 온 주소(NodeId 등) */
  source?: string;
  observedAt: string;
  valueNumber?: number;
  valueText?: string;
  /** 품질(OPC UA StatusCode 등). 나쁜 값도 버리지 않고 표시해 남긴다 */
  quality?: string;
}

export interface ValueQuery {
  interfaceName?: string;
  propertyName?: string;
  /** ISO 시각. 포함(>=) */
  from?: string;
  /** ISO 시각. 미포함(<) */
  to?: string;
  /** 기본 1000 */
  limit?: number;
}

export type HistoryOperation = 'update' | 'delete';

/**
 * 바꾼 사람 — 감사 기록의 「누가」(2026-10-02).
 *
 * 🔴 **이름을 같이 베껴 둔다.** 사람 표를 참조만 하면 계정을 지우거나 이름을 바꿨을 때
 *    과거 기록이 함께 바뀌어 버린다. 감사 기록은 **그때 그 이름**이어야 한다.
 */
export interface Actor {
  /** 사용자 id. 사람이 아니면 `apikey:full` 같은 표시용 값이 온다 */
  id: string;
  /** 그때의 표시 이름 */
  name: string;
}

/** 버전 이력 — 기획서 M1의 "버전 관리". A안에서 되돌리기의 근거가 된다 */
export interface HistoryRecord {
  uid: string;
  packageId: string;
  modelType: IdentifiableModelType;
  id: string;
  /** 이 이력이 담고 있는 **변경 전** 리비전 */
  revision: number;
  content: Record<string, unknown>;
  operation: HistoryOperation;
  changedAt: string;
  /**
   * 누가 바꿨나. **없을 수 있다** — 로그인을 쓰지 않는 서버(설치판·혼자 쓰기)와
   * 2026-10-02 이전에 쌓인 이력이 그렇다. 화면은 빈 칸을 「기록 없음」으로 읽는다.
   */
  actorId?: string;
  actorName?: string;
}

export interface PageQuery {
  /** 한 번에 가져올 개수. Part 2의 limit에 대응 */
  limit?: number;
  /** 직전 응답의 cursor. Part 2의 cursor에 대응 */
  cursor?: string;
}

/**
 * 목록 필터 — IDTA Part 2의 질의 인자(idShort · semanticId · assetKind)에 대응한다.
 * 조회용 파생 컬럼과 짝이며, Postgres에서는 인덱스가 그대로 쓰인다.
 */
export interface IdentifiableFilter {
  idShort?: string;
  semanticId?: string;
  assetKind?: string;
}

export interface ListQuery extends PageQuery, IdentifiableFilter {}

export interface PageResult<T> {
  items: T[];
  /** 다음 쪽이 있으면 채워진다 */
  cursor?: string;
}

export interface CreateOptions {
  /**
   * 넣을 자리(ordinal). 비우면 맨 뒤.
   * 🔴 「바꾸기」(지우고 새로 넣기)가 자리를 잃지 않게 하려고 둔 것이다 — 필수 서브모델 4종의
   *    순서가 화면에서 깨져 보였다(2026-09-07 실전 검증). 같은 ordinal이 이미 있어도 막지 않는다:
   *    정렬은 안정적이고, 지운 자리에 다시 넣는 쓰임새가 전부다.
   */
  ordinal?: number;
}

export interface WriteOptions {
  /**
   * 기대 리비전. 지정하면 다르면 ConflictError를 던진다(낙관적 잠금).
   * 기획서 Ⅷ "동시 편집 — 낙관적 잠금 또는 버전 충돌 처리"에 대응한다.
   */
  expectedRevision?: number;
  /**
   * 이 변경을 한 사람. 비우면 요청 문맥(`runAsActor`)에서 집어 온다 —
   * 보통은 비워 두고, 저장소를 직접 쓰는 쪽만 채운다. 자세한 사유는 actor.ts.
   */
  actor?: Actor;
}

/** 목록을 누구의 눈으로 볼 것인가 — 그 주인의 것 + 공용 */
export interface PackageScope {
  owner: string;
}

/** 볼 수는 있지만 고칠 수 없는 것 — API 계층에서 403으로 옮긴다 */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what}을(를) 찾을 수 없습니다.`);
    this.name = 'NotFoundError';
  }
}

/** 저장할 수 없는 내용 — API 계층에서 400으로 옮긴다 */
export class InvalidContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContentError';
  }
}

export class ConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`리비전이 어긋납니다: 기대 ${expected}, 현재 ${actual}. 다시 읽고 편집하십시오.`);
    this.name = 'ConflictError';
  }
}

/**
 * 쓰는 사람.
 *
 * 🔴 역할은 셋뿐이다. 더 잘게 나눌수록 "이 사람이 무엇을 할 수 있나"를 아무도 모르게 된다.
 *   · admin  — 계정을 만들고 지운다. 편집자가 하는 일을 다 할 수 있다
 *   · editor — 파일을 올리고 고치고 내려받는다 (지금의 전체 권한 토큰)
 *   · viewer — 보기만 (지금의 읽기 전용 토큰)
 */
export type UserRole = 'admin' | 'editor' | 'viewer';

export interface UserRecord {
  id: string;
  /** 로그인에 쓰는 이름. 대소문자를 가리지 않게 소문자로 저장한다 */
  login: string;
  displayName: string;
  role: UserRole;
  /**
   * 연락처 — **선택**이다(2026-10-04).
   *
   * 🔴 일부러 **확인하지 않는다.** 메일 서버가 없고, 확인 절차를 흉내만 내면
   *    「확인된 주소」라고 믿게 만들어 더 나쁘다. 그냥 적어 둔 값이다.
   * 🔴 개인정보다. 받기 시작하면 처리방침·동의·보관기간·파기가 따라온다
   *    (docs/배포_호스팅.md). 그래서 비울 수 있게 두었다.
   */
  email?: string;
  /** 회사명 — 회원가입 때 받는다(처리방침을 올린 서버에서만). 2026-10-06 */
  company?: string;
  /**
   * 개인정보 수집·이용에 동의한 시각. 🔴 「동의했다」는 증빙이다 — 체크했다는 사실을
   * 서버가 직접 적어 둔다(화면이 보냈다는 것만으로는 나중에 보일 것이 없다)
   */
  consentAt?: string;
  /** 🔴 해시만 둔다. 원문 비밀번호는 어디에도 남기지 않는다 */
  passwordHash: string;
  /** 잠근 계정 — 지우지 않고 막는다. 이력에 남은 「누가」가 깨지지 않게 */
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** 새 계정을 만들 때 받는 것 */
export interface NewUser {
  login: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
  /** 선택 — 위 UserRecord.email 설명을 볼 것 */
  email?: string;
  company?: string;
  consentAt?: string;
}

/**
 * 저장소 포트.
 *
 * 구현체는 두 개다 — InMemoryStore(개발·테스트)와 PostgresStore(운영).
 * 같은 적합성 테스트(test/conformance.ts)를 두 구현에 모두 돌려 동작 차이를 막는다.
 */
export interface AasStore {
  /** 스키마 준비 등 1회성 초기화. 인메모리는 아무 것도 하지 않는다 */
  init(): Promise<void>;

  // ── 패키지 ────────────────────────────────────────────────────────────────
  /**
   * `keep` — AASX 파트 말고 **함께 보관할 파일**(role `bundle`). 올린 원본 바이트 같은 것.
   * 🔴 담는 동작 안에서 넣는다 — 따로 putPackageFile하면 리비전이 올라 방금 올린 파일이 「고친 파일」로 보인다
   */
  importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    /**
     * 주인. 비우면 지금 작업 공간의 것이 되고(작업 공간이 없으면 공용),
     * **`null`은 「일부러 공용」** 이다 — 공용 파일을 통째로 바꿀 때 공용으로 남기려고 쓴다.
     */
    owner?: string | null;
  }): Promise<PackageRecord>;
  /** 저장된 것을 원래 AASX 구조로 되돌린다. writeAasx에 그대로 넘길 수 있다 */
  exportPackage(packageId: string): Promise<AasxPackage>;
  getPackage(packageId: string): Promise<PackageRecord | undefined>;
  /**
   * `scope`를 주면 **그 주인의 것과 공용(주인 없음)만** 돌려준다.
   * 🔴 거르는 일을 저장소가 한다 — 받아 온 뒤에 밖에서 거르면 `limit`·`cursor`가 틀어진다
   *    (한 쪽 20건 중 내 것이 3건이면 3건만 오고, 다음 쪽이 있는지도 알 수 없다).
   */
  listPackages(page?: PageQuery, scope?: PackageScope): Promise<PageResult<PackageRecord>>;
  deletePackage(packageId: string): Promise<void>;
  /** 모델만 필요할 때. 린터·Quick Fix에 그대로 넘긴다 */
  getEnvironment(packageId: string): Promise<Environment>;

  // ── 비모델 파트 (썸네일·첨부) ──────────────────────────────────────────────
  // Part 2의 asset-information/thumbnail처럼 파일 하나만 다뤄야 하는 연산이 있다.
  // 통째로 export해서 골라내면 Identifiable을 전부 읽는 낭비가 된다.
  packageFiles(packageId: string): Promise<PackageFileRecord[]>;
  putPackageFile(packageId: string, file: PackageFileRecord): Promise<void>;
  /** 없으면 NotFoundError */
  deletePackageFile(packageId: string, part: string): Promise<void>;

  // ── Identifiable CRUD (IDTA Part 2의 /shells · /submodels · /concept-descriptions) ──
  listIdentifiables(
    packageId: string,
    modelType: IdentifiableModelType,
    query?: ListQuery,
  ): Promise<PageResult<IdentifiableRecord>>;
  getIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<IdentifiableRecord | undefined>;
  createIdentifiable(
    packageId: string,
    content: Record<string, unknown>,
    options?: CreateOptions,
  ): Promise<IdentifiableRecord>;
  updateIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    content: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<IdentifiableRecord>;
  deleteIdentifiable(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
    options?: WriteOptions,
  ): Promise<void>;

  // ── 수집값 (시계열) ───────────────────────────────────────────────────────
  /** 모아 온 값을 쌓는다. 모델은 건드리지 않는다(A안) */
  appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void>;
  /** 최근 것이 앞에 온다 */
  readValues(packageId: string, query?: ValueQuery): Promise<CollectedValue[]>;
  /**
   * `before`(ISO 시각)보다 오래된 수집값을 **모든 패키지에서** 지우고 지운 개수를 돌려준다.
   * 보존 기간(retention) 집행용 — 모델·리비전은 건드리지 않는다.
   */
  pruneValues(before: string): Promise<number>;

  /** 변경 전 내용들. 최신 변경이 앞이다 */
  history(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<HistoryRecord[]>;

  // ── 사용자 (2026-10-02) ───────────────────────────────────────────────────
  /** 로그인 이름으로 찾는다. 잠긴 계정도 돌려준다 — 막는 판단은 부르는 쪽이 한다 */
  findUserByLogin(login: string): Promise<UserRecord | undefined>;
  getUser(id: string): Promise<UserRecord | undefined>;
  /** 만든 차례대로. 계정 관리 화면이 쓴다 */
  listUsers(): Promise<UserRecord[]>;
  /** 🔴 같은 login이 이미 있으면 거절한다(표의 UNIQUE와 같은 뜻을 메모리 구현에도 세운다) */
  createUser(user: NewUser): Promise<UserRecord>;
  /** 비밀번호·이름·역할·잠금을 고친다. 준 것만 바꾼다 */
  updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email'>>,
  ): Promise<UserRecord | undefined>;
  /** 로그인에 성공한 시각 — 안 쓰는 계정을 가려내는 근거 */
  touchUserLogin(id: string): Promise<void>;
  /**
   * 계정을 **지운다**(탈퇴). 없으면 false.
   *
   * 🔴 감사 기록은 **남는다.** 이력에 적힌 「누가」는 사람 표를 참조하지 않고 그때의
   *    이름을 베껴 둔 값이라(2026-10-02) 계정이 사라져도 과거가 깨지지 않는다.
   *    개인정보를 지우라는 요구에 응하면서 「무슨 일이 있었나」는 지키는 설계다.
   * 🔴 잠그기(disabled)와 다르다. 잠그면 연락처가 남는다 — 지우라는 요구에는 모자란다.
   */
  deleteUser(id: string): Promise<boolean>;
  /** 계정이 하나도 없으면 **첫 관리자 만들기**를 띄워야 한다 */
  countUsers(): Promise<number>;
}
