/**
 * Store contract — spec M1.
 *
 * Value sync policy **Option A (the file is the original)** determines this design (docs/PROGRESS.md §2-2).
 *  - Identifiables are stored as **the whole original JSON**. Query columns are merely derived; if they disagree, the original wins.
 *  - A package's thumbnail, attachments and other parts are stored too. Without them export is not lossless.
 *  - Array order (ordinal) is preserved. If the order changes, the round trip differs from the original.
 *
 * And one more — **defective files are also accepted without loss.**
 * If the store enforced validity, the very things the linter (M5) should flag could never get in.
 * That is why there is no UNIQUE on id (KOSMO-CD-5 duplicate ids are a measured defect).
 */
import type { AasxPackage } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { fill, tr } from '@aas/core';

import type { IntegrationStore } from './integration-types.js';

export type IdentifiableModelType =
  | 'AssetAdministrationShell'
  | 'Submodel'
  | 'ConceptDescription';

export const IDENTIFIABLE_MODEL_TYPES: readonly IdentifiableModelType[] = [
  'AssetAdministrationShell',
  'Submodel',
  'ConceptDescription',
];

/** Which Environment array it belongs to — the basis of lossless round trips */
export const ENVIRONMENT_FIELD: Record<IdentifiableModelType, keyof Environment> = {
  AssetAdministrationShell: 'assetAdministrationShells',
  Submodel: 'submodels',
  ConceptDescription: 'conceptDescriptions',
};

/** Unit of work corresponding to one AASX file */
export interface PackageRecord {
  id: string;
  /** Original file name — the human-recognizable name */
  name: string;
  /** AAS body part name. Default /aasx/data.json */
  specPart: string;
  /** For optimistic locking. Incremented whenever a contained Identifiable changes */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Owner — which workspace it belongs to (2026-10-04).
   *
   * **Absent means "shared".** On a server shared by a team (the default) no package has an owner,
   * and everyone sees everything — it behaves exactly as before this field existed.
   * On a server that splits workspaces (trial edition), the uploader's key is recorded and only that person sees it.
   * Even then, ownerless items (templates loaded at startup) **can be read** by anyone (scoped.ts).
   */
  owner?: string;
}

/**
 * - thumbnail · supplementary · extra — parts inside the AASX. On export they go into the AASX as-is
 * - **bundle** — documents/evidence attached to a reference bundle (Use-Case, guidance, collection logs…). Important: **not put into the AASX.**
 *   If the process file's hash changes, bundle verification breaks. Kept only so it can be restored when the bundle is re-exported (2026-09-30)
 */
export type PackageFileRole = 'thumbnail' | 'supplementary' | 'extra' | 'bundle';

/** Non-model parts required for lossless export */
export interface PackageFileRecord {
  part: string;
  role: PackageFileRole;
  contentType: string;
  data: Uint8Array;
}

export interface IdentifiableRecord {
  /** Store-internal key. Kept separate from id because duplicate-id defects must also be stored */
  uid: string;
  packageId: string;
  modelType: IdentifiableModelType;
  id: string;
  idShort?: string;
  /** First key value of semanticId — a derived column for query convenience */
  semanticId?: string;
  /** The AAS's assetInformation.assetKind */
  assetKind?: string;
  /** The Submodel's kind */
  kind?: string;
  /** Original order within the Environment array */
  ordinal: number;
  /** The original JSON as-is */
  content: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}

/**
 * Collected values — spec M8 · Phase 5.
 *
 * Important: value sync **Option A**: these values **never flow back into the model.** They only reference the model tables;
 * there is no reverse direction. Since the deliverable is a Type/Template, writing runtime values back would violate metamodel semantics.
 */
export interface CollectedValue {
  packageId: string;
  /** AID interface name */
  interfaceName: string;
  /** AID property name */
  propertyName: string;
  /** Address it was read from (NodeId, etc.) */
  source?: string;
  observedAt: string;
  /**
   * The time **this tool actually read it** (ISO). Added 2026-10-13.
   * Important: `observedAt` is the time given by the device (OPC UA SourceTimestamp), so it **only moves when the value changes** — for tags with a
   *    constant value, the timestamp stays frozen in the past even though they are read fine every time, so judging "receiving" by it makes healthy tags look disconnected.
   *    A receive time is kept separately per value (lesson from real operation — in a digital-twin check all 271 rows had the same timestamp, so "receiving"
   *    lost its meaning). Old records lack it — observedAt is used instead in that case.
   */
  receivedAt?: string;
  valueNumber?: number;
  valueText?: string;
  /** Quality (OPC UA StatusCode, etc.). Bad values are not discarded but kept with their marking */
  quality?: string;
}

export interface ValueQuery {
  interfaceName?: string;
  propertyName?: string;
  /** ISO time. Inclusive (>=) */
  from?: string;
  /** ISO time. Exclusive (<) */
  to?: string;
  /** Default 1000 */
  limit?: number;
  /**
   * Which timestamp from · to · sorting use. Default observed (device time — the hypertable is partitioned on this column, so it is fast).
   * received = receive time (device time for old records lacking it). For constant-value tags the device time is frozen, so
   * selecting "values received today" by device time misses them — used where the time of receipt matters, such as a daily status bar (2026-10-14).
   */
  basis?: 'observed' | 'received';
}

export type HistoryOperation = 'update' | 'delete';

/**
 * The person who made a change — the "who" of the audit log (2026-10-02).
 *
 * Important: **the name is copied along with it.** If only the users table were referenced, deleting an account or renaming
 *    someone would change past records too. An audit log must keep **the name as it was at the time**.
 */
export interface Actor {
  /** User id. For non-humans, a display value such as `apikey:full` arrives */
  id: string;
  /** Display name at the time */
  name: string;
}

/** Version history — the "version management" of spec M1. Under Option A it is the basis for reverting */
export interface HistoryRecord {
  uid: string;
  packageId: string;
  modelType: IdentifiableModelType;
  id: string;
  /** The revision **before the change** that this history entry holds */
  revision: number;
  content: Record<string, unknown>;
  operation: HistoryOperation;
  changedAt: string;
  /**
   * Who changed it. **May be absent** — on servers without login (installed edition, single user) and for
   * history accumulated before 2026-10-02. The UI reads an empty cell as "no record".
   */
  actorId?: string;
  actorName?: string;
}

export interface PageQuery {
  /** Number of items to fetch at once. Corresponds to Part 2's limit */
  limit?: number;
  /** cursor from the previous response. Corresponds to Part 2's cursor */
  cursor?: string;
}

/**
 * List filter — corresponds to IDTA Part 2 query parameters (idShort · semanticId · assetKind).
 * Pairs with the derived query columns; in Postgres the indexes are used directly.
 */
export interface IdentifiableFilter {
  idShort?: string;
  semanticId?: string;
  assetKind?: string;
}

export interface ListQuery extends PageQuery, IdentifiableFilter {}

export interface PageResult<T> {
  items: T[];
  /** Filled when there is a next page */
  cursor?: string;
}

export interface CreateOptions {
  /**
   * Position to insert at (ordinal). Empty means the end.
   * Important: exists so that "replace" (delete then insert) does not lose its position — the order of the 4 mandatory
   *    submodels appeared broken on screen (2026-09-07 field verification). Not blocked even if the same ordinal already exists:
   *    sorting is stable, and re-inserting into a deleted slot is the only use case.
   */
  ordinal?: number;
}

export interface WriteOptions {
  /**
   * Expected revision. If given and different, throws ConflictError (optimistic locking).
   * Corresponds to spec Ⅷ "concurrent editing — optimistic locking or version conflict handling".
   */
  expectedRevision?: number;
  /**
   * The person who made this change. If empty, it is picked up from the request context (`runAsActor`) —
   * usually left empty; only callers using the store directly fill it in. See actor.ts for the full rationale.
   */
  actor?: Actor;
}

/** Whose eyes to view the list through — that owner's items + shared */
export interface PackageScope {
  owner: string;
}

/** Visible but not editable — mapped to 403 in the API layer */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(fill(tr('{0}을(를) 찾을 수 없습니다.'), { 0: what }));
    this.name = 'NotFoundError';
  }
}

/** Content that cannot be stored — mapped to 400 in the API layer */
export class InvalidContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContentError';
  }
}

/**
 * A package id this store cannot use (the folder store refuses anything but a plain name — it becomes a path).
 * Important: a subclass of InvalidContentError so the API answers 400 like any other bad input, not 500.
 */
export class InvalidPackageIdError extends InvalidContentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPackageIdError';
  }
}

export class ConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(fill(tr('리비전이 어긋납니다: 기대 {0}, 현재 {1}. 다시 읽고 편집하십시오.'), { 0: expected, 1: actual }));
    this.name = 'ConflictError';
  }
}

/**
 * A user.
 *
 * Important: there are only three roles. The finer they are split, the less anyone knows "what this person can do".
 *   · admin  — creates and deletes accounts. Can do everything an editor can
 *   · editor — uploads, edits and downloads files (the current full-access token)
 *   · viewer — view only (the current read-only token)
 */
export type UserRole = 'admin' | 'editor' | 'viewer';

export interface UserRecord {
  id: string;
  /** Name used to log in. Stored in lowercase so it is case-insensitive */
  login: string;
  displayName: string;
  role: UserRole;
  /**
   * Contact — **optional** (2026-10-04).
   *
   * Important: deliberately **not verified.** There is no mail server, and merely imitating a verification step
   *    would make people believe it is a "verified address", which is worse. It is just a value someone wrote down.
   * Important: this is personal data. Once collected, a privacy policy, consent, retention period and disposal follow
   *    (docs/배포_호스팅.md). That is why it can be left empty.
   */
  email?: string;
  /** Company name — collected at sign-up (only on servers that publish a privacy policy). 2026-10-06 */
  company?: string;
  /**
   * Time of consent to the collection and use of personal data. Important: "consented" is evidence — the server records
   * the fact of the checkbox itself (that the UI sent it alone leaves nothing to show later)
   */
  consentAt?: string;
  /** Important: hash only. The plaintext password is kept nowhere */
  passwordHash: string;
  /** Locked account — blocked rather than deleted, so the "who" recorded in history does not break */
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** What is accepted when creating a new account */
export interface NewUser {
  login: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
  /** Optional — see the UserRecord.email description above */
  email?: string;
  company?: string;
  consentAt?: string;
}

/**
 * Store port.
 *
 * Three implementations — InMemoryStore (development/testing), FolderStore (single-user installs, extends the memory
 * store) and PostgresStore (production). The same conformance tests (test/conformance.ts, including
 * test/conformance-integration.ts) run against all of them to prevent behavioral differences.
 *
 * The integration part (`IntegrationStore`, docs/design/integration-v1.md §3) is in the port, not beside it: every
 * mutating model method below also records a **model event** in the same commit (outbox) — with the actor
 * (`runAsActor`), the change context (`runWithChange`), the package owner and the package revision after the change.
 * A failed write (e.g. `ConflictError`) records nothing.
 */
export interface AasStore extends IntegrationStore {
  /** One-time initialization such as preparing the schema. The in-memory store does nothing */
  init(): Promise<void>;

  // ── Packages ──────────────────────────────────────────────────────────────
  /**
   * `keep` — **files to store alongside** besides the AASX parts (role `bundle`), such as the uploaded original bytes.
   * Important: put them in within the import operation — a separate putPackageFile bumps the revision, so the just-uploaded file looks "edited"
   */
  importPackage(input: {
    name: string;
    package: AasxPackage;
    id?: string;
    keep?: readonly PackageFileRecord[];
    /**
     * Owner. If empty, it belongs to the current workspace (shared if there is no workspace);
     * **`null` means "deliberately shared"** — used to keep a shared file shared when replacing it wholesale.
     */
    owner?: string | null;
  }): Promise<PackageRecord>;
  /** Restores stored data to the original AASX structure. Can be passed straight to writeAasx */
  exportPackage(packageId: string): Promise<AasxPackage>;
  getPackage(packageId: string): Promise<PackageRecord | undefined>;
  /**
   * Given `scope`, returns **only that owner's items and shared (ownerless) items**.
   * Important: the store does the filtering — filtering outside after fetching breaks `limit`/`cursor`
   *    (if only 3 of 20 items on a page are mine, only 3 arrive, and there is no way to know whether a next page exists).
   */
  listPackages(page?: PageQuery, scope?: PackageScope): Promise<PageResult<PackageRecord>>;
  deletePackage(packageId: string): Promise<void>;
  /** When only the model is needed. Passed straight to the linter / Quick Fix */
  getEnvironment(packageId: string): Promise<Environment>;

  // ── Non-model parts (thumbnail, attachments) ──────────────────────────────
  // Some operations, like Part 2's asset-information/thumbnail, deal with a single file only.
  // Exporting everything and picking one out wastes reading all Identifiables.
  packageFiles(packageId: string): Promise<PackageFileRecord[]>;
  putPackageFile(packageId: string, file: PackageFileRecord): Promise<void>;
  /** NotFoundError if absent */
  deletePackageFile(packageId: string, part: string): Promise<void>;

  // ── Identifiable CRUD (IDTA Part 2's /shells · /submodels · /concept-descriptions) ──
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

  // ── Collected values (time series) ────────────────────────────────────────
  /** Appends collected values. Does not touch the model (Option A) */
  appendValues(packageId: string, values: readonly CollectedValue[]): Promise<void>;
  /** Most recent first */
  readValues(packageId: string, query?: ValueQuery): Promise<CollectedValue[]>;
  /**
   * Deletes collected values older than `before` (ISO time) **across all packages** and returns the number deleted.
   * For enforcing the retention period — does not touch models or revisions.
   */
  pruneValues(before: string): Promise<number>;

  /** Contents before changes. Most recent change first */
  history(
    packageId: string,
    modelType: IdentifiableModelType,
    id: string,
  ): Promise<HistoryRecord[]>;

  // ── Users (2026-10-02) ────────────────────────────────────────────────────
  /** Finds by login name. Locked accounts are returned too — the caller decides whether to block */
  findUserByLogin(login: string): Promise<UserRecord | undefined>;
  getUser(id: string): Promise<UserRecord | undefined>;
  /** In creation order. Used by the account management screen */
  listUsers(): Promise<UserRecord[]>;
  /** Important: rejects if the same login already exists (enforces the same meaning as the table's UNIQUE in the memory implementation too) */
  createUser(user: NewUser): Promise<UserRecord>;
  /**
   * Creates the account **only if there is none yet** — undefined otherwise. The check and the insert are one step.
   * Important: "count, then create" with anything awaited in between (the password hash) let two first-admin setups
   *    racing each other both succeed (red-team L3, 2026-10-16). Each implementation makes this atomic in its own way.
   */
  createFirstUser(user: NewUser): Promise<UserRecord | undefined>;
  /** Edits password, name, role and lock state. Changes only what is given */
  updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'disabled' | 'email' | 'company'>>,
  ): Promise<UserRecord | undefined>;
  /** Time of successful login — the basis for spotting unused accounts */
  touchUserLogin(id: string): Promise<void>;
  /**
   * **Deletes** an account (withdrawal). false if absent.
   *
   * Important: the audit log **remains.** The "who" recorded in history does not reference the users table but is a copy
   *    of the name at the time (2026-10-02), so the past does not break even when the account disappears.
   *    A design that complies with requests to erase personal data while preserving "what happened".
   * Important: different from locking (disabled). Locking keeps the contact details — not enough for an erasure request.
   */
  deleteUser(id: string): Promise<boolean>;
  /** If there are no accounts at all, **create the first admin** must be shown */
  countUsers(): Promise<number>;
}
