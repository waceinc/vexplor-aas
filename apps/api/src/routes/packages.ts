/**
 * AASX file server interface — IDTA-01002-3-0 `AasxFileServerServiceSpecification/SSP-001`.
 *
 * We first built this on our own ad-hoc paths, then while checking against the spec text (docs/spec/part2/)
 * we found **the standard already defines the same paths**, so we aligned with the spec.
 *   GET  /packages                 package list (PackageDescription)
 *   POST /packages                 store AASX via multipart/form-data → 201 + Location
 *   GET  /packages/{packageId}     returns **the AASX file itself** (not JSON metadata)
 *   PUT  /packages/{packageId}     replace → 204
 *   DELETE /packages/{packageId}   delete → 204
 *
 * Our own extensions live under sub-paths so they do not intrude on spec paths — `/metadata` · `/lint` · `/fix`.
 * `node scripts/part2-coverage.mjs` watches whether we have opened any path not in the spec.
 */
import { DEFAULT_SPEC_PART, readAasx, writeAasx, type AasxLimits } from '@aas/aasx';
import {
  AidBuildError,
  aidConceptDescriptions,
  mergeRuntimeGroup,
  RuntimeBuildError,
  valuedNames,
  buildAidSubmodel,
  CollectionRunner,
  latestByProperty,
  overlayEnvironment,
  parseAid,
  type AidInterface,
  type ProtocolReader,
} from '@aas/collector';
import {
  ALL_RULES,
  DEFAULT_POLICY,
  formatHtmlReport,
  addChild,
  childNodes,
  findEntryNode,
  hierarchyTree,
  lineConceptDescription,
  HIERARCHY_SUBMODEL_ID_SHORT,
  isValidAssetName,
  lint,
  ruleCatalog,
  overviewUml,
  planFor,
  submodelInfo,
  submodelTable,
  submodelTables,
  submodelTablesHtml,
  submodelUml,
  tableCsv,
  lintAndFix,
  revertRelocations,
  type FixSelector,
  placeholderThumbnail,
  removeChild,
  renameEnvironment,
  scaffoldEnvironment,
  type Finding,
  type LinterPolicy,
} from '@aas/linter';
import type { Environment } from '@aas/core';
import {
  IDENTIFIABLE_MODEL_TYPES,
  type AasStore,
  type IdentifiableModelType,
  type PackageRecord,
} from '@aas/store';
import { decodeIdentifier } from '../base64url.js';
import { ApiError, bytes, json, noContent, pagedResponse, type ApiRequest } from '../http.js';
import { fieldValues, fileOf, MultipartError, parseMultipart } from '../multipart.js';
import type { Route } from '../router.js';
import { withSafeThumbnail } from '../user-file.js';
import { originalFile } from './bundle-files.js';
import { derivationFile, newDerivation } from './derivation.js';
import { fill, tr } from '@aas/core';

/** Media type of an AASX package (spec AasxFileServer §GetAASXByPackageId) */
export const AASX_MEDIA_TYPE = 'application/asset-administration-shell-package';

/**
 * Timestamp printed on reports — these are submission documents, so use **the server's local time**.
 * Printing ISO (UTC) produced a document 9 hours off from the on-screen clock (2026-09-03 demo).
 * Seconds are dropped — minutes are enough to tell documents apart, and easier to compare by eye
 */
export function localTimestamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

interface UploadedPackage {
  name: string;
  data: Uint8Array;
}

/**
 * Reads the upload body.
 *  - Spec: multipart/form-data (fileName · file · aasIds)
 *  - Extension: raw AASX bytes in the body plus `?name=` — a form that is convenient for our authoring UI
 */
function uploadedPackage(request: ApiRequest): UploadedPackage {
  const contentType = request.headers['content-type'] ?? '';
  const body = request.body;

  if (contentType.includes('multipart/form-data')) {
    if (!(body instanceof Uint8Array)) {
      throw new ApiError(400, 'BadRequest', tr('multipart 본문을 읽지 못했습니다.'));
    }
    let parts;
    try {
      parts = parseMultipart(body, contentType);
    } catch (error) {
      throw new ApiError(400, 'BadRequest', error instanceof MultipartError ? error.message : String(error));
    }
    const file = fileOf(parts, 'file');
    if (!file) throw new ApiError(400, 'BadRequest', tr('file 조각이 없습니다.'));
    const name = fieldValues(parts, 'fileName')[0] ?? file.filename ?? 'package.aasx';
    return { name, data: file.data };
  }

  if (!(body instanceof Uint8Array)) {
    throw new ApiError(400, 'BadRequest', tr('본문이 AASX 바이트가 아닙니다.'));
  }
  const name = request.query['name'];
  if (!name) {
    throw new ApiError(
      400,
      'BadRequest',
      tr('multipart/form-data로 보내거나(규격), name 질의 인자를 함께 주십시오(확장).'),
    );
  }
  return { name, data: body };
}

/** The spec's PackageDescription, with our metadata appended (the spec does not forbid extra properties) */
async function packageDescription(
  store: AasStore,
  record: PackageRecord,
): Promise<Record<string, unknown>> {
  const shells = await store.listIdentifiables(record.id, 'AssetAdministrationShell');
  const first = shells.items[0];
  return {
    packageId: record.id,
    aasIds: shells.items.map((r) => r.id),
    // ↓ Non-spec extensions. Standard clients ignore unknown fields
    name: record.name,
    // Important: include the equipment name and Asset address in the list. Building a process requires knowing
    //    "what equipment this file is" to pick it, but file names mix in project numbers, like "03-SPR-equipment-80.aasx",
    //    so the name alone is not enough to tell
    assetName: first?.idShort,
    globalAssetId: (first?.content as { assetInformation?: { globalAssetId?: string } } | undefined)
      ?.assetInformation?.globalAssetId,
    // Whether this is a process (composite) file — the standard field the UI uses to tell equipment from processes (…/type/*)
    assetType: (first?.content as { assetInformation?: { assetType?: string } } | undefined)?.assetInformation
      ?.assetType,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Turns the stored copy back into AASX so L1 (package) rules can be checked too.
 * L1 rules look at ZIP parts, relationships and Content_Types, so the Environment alone cannot be checked.
 */
async function snapshot(store: AasStore, packageId: string): Promise<ReturnType<typeof readAasx>> {
  const exported = await store.exportPackage(packageId);
  return readAasx(writeAasx(exported));
}

/**
 * Writes fix results back to the store.
 * Fixes that change an id (IRI relocation) show up as delete + create — correct, since a new id is a different identity.
 * The relocation ledger (relocations) records that link instead.
 */
async function writeBackEnvironment(
  store: AasStore,
  packageId: string,
  next: Environment,
): Promise<{ created: number; updated: number; deleted: number }> {
  const counts = { created: 0, updated: 0, deleted: 0 };
  const fields: Record<IdentifiableModelType, keyof Environment> = {
    AssetAdministrationShell: 'assetAdministrationShells',
    Submodel: 'submodels',
    ConceptDescription: 'conceptDescriptions',
  };

  for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
    const incoming = (next[fields[modelType]] ?? []) as unknown as Record<string, unknown>[];
    const incomingIds = new Set(incoming.map((c) => String(c['id'])));

    const existing: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listIdentifiables(packageId, modelType, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      existing.push(...page.items.map((r) => r.id));
      cursor = page.cursor;
    } while (cursor);

    for (const content of incoming) {
      const id = String(content['id']);
      if (existing.includes(id)) {
        const current = await store.getIdentifiable(packageId, modelType, id);
        if (current && JSON.stringify(current.content) === JSON.stringify(content)) continue;
        await store.updateIdentifiable(packageId, modelType, id, content);
        counts.updated += 1;
      } else {
        await store.createIdentifiable(packageId, content);
        counts.created += 1;
      }
    }

    for (const id of existing) {
      if (incomingIds.has(id)) continue;
      await store.deleteIdentifiable(packageId, modelType, id);
      counts.deleted += 1;
    }
  }

  return counts;
}

function bodyObject(request: ApiRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || body instanceof Uint8Array) {
    throw new ApiError(400, 'BadRequest', tr('본문이 JSON 객체가 아닙니다.'));
  }
  return body as Record<string, unknown>;
}

/** First key value of a Reference */
/**
 * Finds the hierarchy submodel of a process file.
 *
 * Important: if missing, it is **400**, not 404. The file exists but is not one this feature applies to, so
 *    "used a process feature on an equipment file" is a better explanation than "asked for something missing".
 */
async function findHierarchy(
  store: AasStore,
  packageId: string,
): Promise<{ submodel: Record<string, unknown>; record: PackageRecord }> {
  const record = await store.getPackage(packageId);
  if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
  const submodels = await store.listIdentifiables(packageId, 'Submodel');
  const found = submodels.items.find((item) => item.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
  if (!found) {
    throw new ApiError(
      400,
      'BadRequest',
      fill(tr('이 파일에는 {0} 서브모델이 없습니다 — 공정 파일이 아닙니다.'), { 0: HIERARCHY_SUBMODEL_ID_SHORT }),
    );
  }
  return { submodel: found.content as Record<string, unknown>, record };
}

/**
 * Cycle check — walking down source's hierarchy must never reach target.
 * The asset address → package map is built from all open files (there are few files, so scanning then is fine).
 */
async function guardCycle(store: AasStore, targetId: string, sourceId: string): Promise<void> {
  // asset address → package id
  const byAsset = new Map<string, string>();
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) {
    const shells = await store.listIdentifiables(record.id, 'AssetAdministrationShell');
    const asset = (shells.items[0]?.content as
      | { assetInformation?: { globalAssetId?: string } }
      | undefined)?.assetInformation?.globalAssetId;
    if (asset) byAsset.set(asset, record.id);
  }

  const visited = new Set<string>();
  const walk = async (packageId: string): Promise<boolean> => {
    if (packageId === targetId) return true; // it is a cycle
    if (visited.has(packageId)) return false;
    visited.add(packageId);
    const submodels = await store.listIdentifiables(packageId, 'Submodel');
    const hierarchy = submodels.items.find((item) => item.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
    if (!hierarchy) return false;
    const entry = findEntryNode(hierarchy.content as never);
    if (!entry) return false;
    // Important: inspect the full nesting — references hidden under groups also create cycles
    const flat: { globalAssetId?: string; children: unknown[] }[] = [];
    const collect = (nodes: ReturnType<typeof hierarchyTree>): void => {
      for (const node of nodes) {
        flat.push(node as never);
        collect(node.children);
      }
    };
    collect(hierarchyTree(entry));
    for (const node of flat) {
      const next = node.globalAssetId ? byAsset.get(node.globalAssetId) : undefined;
      if (next && (await walk(next))) return true;
    }
    return false;
  };

  if (await walk(sourceId)) {
    throw new ApiError(
      400,
      'BadRequest',
      tr('넣으려는 파일이 (직접 또는 몇 단계 건너) 이 파일을 이미 담고 있습니다 — 순환이 됩니다.'),
    );
  }
}

/** For history summaries — element count of that revision (recursive) */
function countElements(content: Record<string, unknown>): number {
  let count = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const element of list) {
      count += 1;
      const holder = element as { value?: unknown; statements?: unknown };
      walk(holder.value);
      walk(holder.statements);
    }
  };
  walk((content as { submodelElements?: unknown }).submodelElements);
  return count;
}

/** Unit count written on the child. Defaults to 1 unit */
function bulkCountOf(entity: { statements?: unknown[] }): number {
  const statements = (entity.statements ?? []) as { idShort?: string; value?: string }[];
  const bulk = statements.find((element) => element.idShort === 'BulkCount');
  const value = Number(bulk?.value);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function firstKeyValue(reference: unknown): string | undefined {
  const keys = (reference as { keys?: { value?: unknown }[] } | undefined)?.keys;
  const value = keys?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Collects every semanticId used within a submodel — used to find the CDs that must be brought along */
function semanticIdsOf(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) semanticIdsOf(item, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  const semantic = firstKeyValue(record['semanticId']);
  if (semantic) out.add(semantic);
  for (const value of Object.values(record)) semanticIdsOf(value, out);
  return out;
}

/**
 * Policy overrides from query parameters.
 *
 * This product's principle is not to hide rule conflicts but **to let users choose** (spec §5).
 * In particular, `smlChildIdShort=forbid` is the switch for choosing between "KOSMO submission" and
 * "interoperability with standard tools/BaSyx".
 */
function policyFromQuery(request: ApiRequest): Partial<LinterPolicy> {
  const overrides: Partial<LinterPolicy> = {};
  const sml = request.query['smlChildIdShort'];
  if (sml === 'warn' || sml === 'forbid' || sml === 'allow') overrides.smlChildIdShort = sml;
  const iri = request.query['iriConflict'];
  if (iri === 'kosmo-first' || iri === 'idta-preserve') overrides.iriConflict = iri;
  const terms = request.query['standardTemplateSemantics'];
  if (terms === 'kosmo-first' || terms === 'preserve') overrides.standardTemplateSemantics = terms;
  return overrides;
}

/** Trims the lint result for the response — the authoring UI fetches the full findings separately */
function lintSummary(result: ReturnType<typeof lint>): Record<string, unknown> {
  return {
    passed: result.passed,
    countBySeverity: result.countBySeverity,
    countByRule: result.countByRule,
    rulesRun: result.rulesRun,
  };
}

export interface PackageRouteOptions {
  /** Server default linter policy. Query parameters take precedence when present */
  policy?: Partial<LinterPolicy>;
  /**
   * Decompression cap for uploaded AASX (spec Ⅷ, zip bomb).
   * Tune to the deployment's memory — a small air-gapped server and the cloud cannot be the same.
   */
  aasxLimits?: Partial<AasxLimits>;
  /**
   * How to open a collection adapter (M8). If omitted, collection routes answer 501 —
   * an authoring-only deployment has no reason to load the OPC UA stack.
   */
  openReader?: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /** Device browsing. Injected for the same reason — @aas/opcua is the only place that knows the protocol */
  browseDevice?: (endpoint: string) => Promise<unknown>;
  /**
   * Built-in virtual PLC — given an equipment AASX, creates tags named after its operational data and returns the endpoint and tags.
   * If absent, "Connect to virtual PLC" answers 501 (deployment with collection off)
   */
  simulate?: (
    environment: Environment,
  ) => Promise<{ machine: string; endpoint: string; title: string; tags: { name: string; href: string; type: string }[] }>;
}

/**
 * Fixes one file and writes it back.
 * Extracted so single and batch fixes take **the same path** — if the two diverge, results differ.
 */
/**
 * IRI relocation ledger — kept as a part inside the package (`/aasx/_idta_relocated_iris.json`, same name as in the 20-template work).
 * Important: moved on 2026-09-11 from the fix response alone into a part: if it were "relocate and forget", there would be
 *    no way back when a rule interpretation is reversed (product requirement, spec 04 §5). As a part it ships inside the downloaded .aasx and survives re-upload
 */
const LEDGER_PART = '/aasx/_idta_relocated_iris.json';

async function readLedger(store: AasStore, packageId: string): Promise<Record<string, string>> {
  const files = await store.packageFiles(packageId);
  const part = files.find((file) => file.part === LEDGER_PART);
  if (!part) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(part.data)) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLedger(store: AasStore, packageId: string, ledger: Record<string, string>): Promise<void> {
  if (Object.keys(ledger).length === 0) {
    await store.deletePackageFile(packageId, LEDGER_PART).catch(() => undefined);
    return;
  }
  await store.putPackageFile(packageId, {
    part: LEDGER_PART,
    role: 'extra',
    contentType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(ledger, null, 2)),
  });
}

/** Merges new relocations into the ledger — the earliest recorded original wins (even after two moves, we must return to the very first original) */
async function mergeLedger(store: AasStore, packageId: string, added: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(added).length === 0) return readLedger(store, packageId);
  const current = await readLedger(store, packageId);
  for (const [now, origin] of Object.entries(added)) {
    // If a relocated id was relocated again (original→A→B), the ledger records B→original
    const root = current[origin] ?? origin;
    if (current[now] === undefined) current[now] = root;
  }
  await writeLedger(store, packageId, current);
  return current;
}

/**
 * Fix preview — computes what would be fixed and how **without saving** (user, 2026-09-11: see per-item
 * before/after in a popup and apply only the checked ones). If there is no thumbnail, compute as if a placeholder image part existed —
 * the real apply (fixOne) creates that part, so preview and result must match
 */
async function previewFix(
  store: AasStore,
  packageId: string,
  overrides: Partial<LinterPolicy>,
  includeWarnings: boolean,
): Promise<ReturnType<typeof lintAndFix>> {
  const pkg = await snapshot(store, packageId);
  const hasImage = pkg.opc.parts.some((part) => /\.(png|jpe?g|gif|bmp)$/i.test(part));
  if (!hasImage) pkg.opc.parts.push(placeholderThumbnail().part);
  return lintAndFix(pkg.environment, {
    package: pkg.opc,
    includeWarnings,
    ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
  });
}

async function fixOne(
  store: AasStore,
  packageId: string,
  overrides: Partial<LinterPolicy>,
  /** Whether to also touch fixable warnings — the authoring UI turns this on (2026-09-07). Script calls fix violations only by default */
  includeWarnings = false,
  /** Only what was picked in the preview — all if omitted */
  select?: readonly FixSelector[],
): Promise<{ result: ReturnType<typeof lintAndFix>; counts: unknown; ledger: Record<string, string> }> {
  // Important: thumbnail pre-processing — if the package has no image part at all, the fixer skips everything with
  //    "add a file first", while the UI advertises "fixable" (observed: fixing spun
  //    without effect on the XML fixture). Inserting the placeholder image the scaffold uses lets the
  //    KOSMO-AAS-1 fixer point at it, and writeAasx creates PKG-THUMB-PART's part, relationship and Content_Types.
  //    The "next steps" in the summary tells the user it is a placeholder image.
  const files = await store.packageFiles(packageId);
  const hasImage = files.some((file) => /\.(png|jpe?g|gif|bmp)$/i.test(file.part));
  if (!hasImage) {
    const placeholder = placeholderThumbnail();
    await store.putPackageFile(packageId, {
      part: placeholder.part,
      role: 'thumbnail',
      contentType: placeholder.contentType,
      data: placeholder.data,
    });
  }

  const pkg = await snapshot(store, packageId);
  const result = lintAndFix(pkg.environment, {
    package: pkg.opc,
    includeWarnings,
    ...(select ? { select } : {}),
    ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
  });
  const counts = await writeBackEnvironment(store, packageId, result.environment);
  const ledger = await mergeLedger(store, packageId, result.relocations);
  return { result, counts, ledger };
}

export function packageRoutes(store: AasStore, options: PackageRouteOptions = {}): Route[] {
  const routes = baseRoutes(store, options);
  const aid = routes.find((route) => route.method === 'POST' && route.pattern === '/packages/:packageId/aid')!;
  return [
    ...routes,
    {
      /**
       * "Connect to virtual PLC" — how an evaluator reproduces a bundle with only the installed build (2026-09-30).
       * Attaches this equipment to the built-in virtual PLC and creates a collection connection (AID) from its tags. Creation goes
       * through **exactly the same handling** as "Create collection connection" — if the two paths diverge, results differ.
       * Important: if a collection connection to **a different address** already exists, it is not overwritten (409) — a real PLC connection must not be silently swapped for a simulation.
       */
      method: 'POST',
      pattern: '/packages/:packageId/simulate',
      success: [201],
      async handle(context) {
        if (!options.simulate) {
          throw new ApiError(501, 'NotImplemented', tr('가상 PLC는 수집이 켜진 서버(COLLECT=on)에서만 씁니다.'));
        }
        const packageId = context.params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const environment = (await store.exportPackage(packageId)).environment;
        const assetType = String(environment.assetAdministrationShells?.[0]?.assetInformation?.['assetType' as never] ?? '');
        if (assetType.includes('/type/')) {
          throw new ApiError(400, 'BadRequest', tr('가상 PLC는 설비 파일에 붙입니다 — 공정(묶음) 파일에는 수집할 값이 없습니다.'));
        }
        let sim: Awaited<ReturnType<NonNullable<PackageRouteOptions['simulate']>>>;
        try {
          sim = await options.simulate(environment);
        } catch (error) {
          const message = (error as Error).message;
          throw new ApiError(
            503,
            'ServiceUnavailable',
            /EADDRINUSE|address already in use/i.test(message)
              ? tr('가상 PLC 포트(14850)를 이미 다른 프로그램이 쓰고 있습니다 — 가상PLC_시작.bat 창이 떠 있으면 닫고 다시 누르십시오.')
              : fill(tr('가상 PLC를 띄우지 못했습니다: {0}'), { 0: message }),
          );
        }
        if (sim.tags.length === 0) {
          throw new ApiError(400, 'BadRequest', tr('운전 데이터(OperationalData)에 Property가 없어 흉내 낼 태그가 없습니다.'));
        }
        const existing = parseAid(environment).find((iface) => iface.base && iface.base !== sim.endpoint);
        if (existing) {
          throw new ApiError(
            409,
            'Conflict',
            fill(tr('이미 다른 주소({0})로 수집 연결이 있습니다 — 가상 PLC로 바꾸지 않았습니다. 시연은 「호기별로 나누기」로 만든 호기에서 하십시오.'), { 0: existing.base }),
          );
        }
        await aid.handle({
          ...context,
          request: { ...context.request, body: { endpoint: sim.endpoint, title: sim.title, tags: sim.tags } },
        });
        return json(201, { machine: sim.machine, endpoint: sim.endpoint, title: sim.title, tags: sim.tags.length });
      },
    },
  ];
}

function baseRoutes(store: AasStore, options: PackageRouteOptions): Route[] {
  const readOptions = options.aasxLimits ? { limits: options.aasxLimits } : {};
  return [
    {
      /**
       * Create new equipment.
       *
       * Important: do not hand out an empty AAS. KOSMO requires 4 submodels and caps the total at 6–8.
       * Starting from an empty file means a person must remember and add each one, which is already possible today,
       * so there would be no reason to build this. Provide **a scaffold with 0 violations from birth**.
       */
      method: 'POST',
      pattern: '/packages/new',
      success: [201],
      async handle({ request }) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const assetName = String(body['assetName'] ?? '').trim();
        if (!isValidAssetName(assetName)) {
          throw new ApiError(
            400,
            'BadRequest',
            tr('장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine'),
          );
        }
        const extras = Array.isArray(body['extraSubmodels'])
          ? (body['extraSubmodels'] as unknown[]).map(String)
          : undefined;
        // Equipment / composite. process and company are legacy names — same structure, so accepted as is
        const wanted = String(body['unit'] ?? 'equipment');
        const unit = ['composite', 'process', 'company'].includes(wanted)
          ? (wanted as 'composite' | 'process' | 'company')
          : ('equipment' as const);

        const environment = scaffoldEnvironment({
          assetName,
          unit,
          ...(extras ? { extraSubmodels: extras } : {}),
          ...(options.policy ? { policy: options.policy } : {}),
        });
        const thumbnail = placeholderThumbnail();
        const record = await store.importPackage({
          name: `${assetName}.aasx`,
          package: {
            environment,
            specPart: DEFAULT_SPEC_PART,
            thumbnail: { part: thumbnail.part, contentType: thumbnail.contentType, data: thumbnail.data },
            supplementaryFiles: [],
            extraParts: new Map(),
          },
        });
        const description = await packageDescription(store, record);
        return json(201, description);
      },
    },
    {
      /**
       * File clone — what "split per unit" actually does.
       *
       * Copies everything including submodels, attachments and thumbnail, and **renames ids to the new name**.
       * Handing out an empty node with just a name meant "the existing file's submodels don't come along" (field report).
       */
      method: 'POST',
      pattern: '/packages/:packageId/clone',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = (request.body ?? {}) as Record<string, unknown>;
        const assetName = String(body['assetName'] ?? '').trim();
        if (!isValidAssetName(assetName)) {
          throw new ApiError(
            400,
            'BadRequest',
            tr('이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine_1'),
          );
        }
        const source = await store.getPackage(packageId);
        if (!source) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const exported = await store.exportPackage(packageId);
        const iriBase = (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string;
        let environment: Environment;
        try {
          environment = renameEnvironment(exported.environment, assetName, iriBase);
        } catch (error) {
          throw new ApiError(400, 'BadRequest', (error as Error).message);
        }
        const record = await store.importPackage({
          name: `${assetName}.aasx`,
          package: { ...exported, environment },
          // Type copy — the baseline for pushing later type edits down to this unit (routes/derivation.ts). Not included in the AASX
          keep: [derivationFile(newDerivation(packageId, source.name, exported.environment))],
        });
        return json(201, await packageDescription(store, record));
      },
    },
    {
      method: 'GET',
      pattern: '/packages',
      success: [200],
      async handle({ request }) {
        const page = await store.listPackages(
          request.query['cursor'] ? { cursor: request.query['cursor'] } : {},
        );
        const wanted = request.query['aasId'];
        const aasId = wanted === undefined ? undefined : decodeIdentifier(wanted);

        const descriptions = [];
        for (const record of page.items) {
          const description = await packageDescription(store, record);
          if (aasId !== undefined && !(description['aasIds'] as string[]).includes(aasId)) continue;
          descriptions.push(description);
        }
        return pagedResponse(descriptions, page.cursor);
      },
    },
    {
      method: 'POST',
      pattern: '/packages',
      success: [201],
      async handle({ request }) {
        const upload = uploadedPackage(request);
        // Important: the thumbnail's declared type comes from the uploader's [Content_Types] — store what the bytes prove (H1)
        const pkg = withSafeThumbnail(readAasx(upload.data, readOptions));
        // Keep the original bytes — if not fixed, this exact file goes into the reference bundle (hash check)
        const record = await store.importPackage({ name: upload.name, package: pkg, keep: [originalFile(upload.data)] });
        const description = await packageDescription(store, record);
        return {
          status: 201,
          headers: { 'content-type': 'application/json', location: `/packages/${record.id}` },
          body: { ...description, warnings: pkg.warnings },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const data = writeAasx(await store.exportPackage(packageId));
        return bytes(200, data, AASX_MEDIA_TYPE, record.name);
      },
    },
    {
      method: 'PUT',
      pattern: '/packages/:packageId',
      success: [204],
      async handle({ request, params }) {
        const packageId = params['packageId']!;
        const existing = await store.getPackage(packageId);
        if (!existing) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));

        const upload = uploadedPackage(request);
        const pkg = withSafeThumbnail(readAasx(upload.data, readOptions));
        // Replacing is the same as storing anew. Keep the same packageId to preserve client links
        await store.deletePackage(packageId);
        // Important: **carry the owner over unchanged.** Otherwise the file would belong to whoever replaced it — an admin replacing
        //    someone's file must not make it the admin's, and a shared file must not become one person's
        await store.importPackage({
          id: packageId,
          name: upload.name,
          package: pkg,
          keep: [originalFile(upload.data)],
          owner: existing.owner ?? null,
        });
        return noContent();
      },
    },
    {
      method: 'DELETE',
      pattern: '/packages/:packageId',
      success: [204],
      async handle({ params }) {
        await store.deletePackage(params['packageId']!);
        return noContent();
      },
    },

    // ── Below: non-spec extensions — used by the authoring UI ──────────────────────────────────
    {
      method: 'GET',
      pattern: '/packages/:packageId/metadata',
      async handle({ params }) {
        const record = await store.getPackage(params['packageId']!);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        return json(200, { ...record, ...(await packageDescription(store, record)) });
      },
    },
    {
      /**
       * Submodel change history — the raw material for undo.
       *
       * The store has kept full pre-change content from the start (store.history), but the UI had no way
       * to use it. Having no way to recover from mistakes (wrong delete, wrong edit) was a hole
       * found in real-use validation (2026-08-26).
       */
      method: 'GET',
      pattern: '/packages/:packageId/history/:submodelId',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const submodelId = decodeIdentifier(params['submodelId']!);
        const entries = await store.history(packageId, 'Submodel', submodelId);
        return json(200, {
          result: entries.map((entry) => ({
            changedAt: entry.changedAt,
            operation: entry.operation,
            revision: entry.revision,
            // A hint for people to tell "which revision" — the element count at that time
            elementCount: countElements(entry.content),
            // "Who" — may be missing (servers without login, records before 2026-10-02)
            actorName: entry.actorName,
          })),
        });
      },
    },
    {
      /**
       * Restores one revision from history.
       * Important: the restore itself is recorded in history too (it goes through updateIdentifiable) —
       *    a restore can itself be undone. Better than silently overwriting and moving on.
       */
      method: 'POST',
      pattern: '/packages/:packageId/history/:submodelId/restore',
      success: [200],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const submodelId = decodeIdentifier(params['submodelId']!);
        const changedAt = String(bodyObject(request)['changedAt'] ?? '');
        const entries = await store.history(packageId, 'Submodel', submodelId);
        const entry = entries.find((candidate) => candidate.changedAt === changedAt);
        if (!entry) throw new ApiError(404, 'NotFound', tr('그 시각의 이력이 없습니다.'));
        const current = await store.getIdentifiable(packageId, 'Submodel', submodelId);
        if (current) {
          await store.updateIdentifiable(packageId, 'Submodel', submodelId, entry.content);
        } else {
          // Restoring a deleted submodel — the delete history entry holds the last content
          await store.createIdentifiable(packageId, entry.content);
        }
        return json(200, { restored: changedAt });
      },
    },
    {
      /**
       * Process hierarchy — shows what it is made of.
       *
       * A process file **does not contain equipment details itself.** It only points to equipment files
       * through a single link, globalAssetId (same spirit as value-sync option A — there is one source of truth).
       * So the UI needs a place to ask "what is attached".
       */
      method: 'GET',
      pattern: '/packages/:packageId/hierarchy',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const { submodel } = await findHierarchy(store, packageId);
        const entry = findEntryNode(submodel as never);
        if (!entry) return json(200, { entryNode: null, children: [] });
        // Important: return a nested tree — the goal is drawing company > process > equipment within one file,
        //    so returning a single level would hide everything below. Groups (intermediate nodes) have no globalAssetId
        // Important: fill globalAssetId on every level, even if just an empty string. When only the top level was filled,
        //    the key went missing from nested groups and the UI mistook groups for equipment (observed)
        const normalize = (
          nodes: ReturnType<typeof hierarchyTree>,
        ): { name: string; globalAssetId: string; bulkCount: number; line: boolean; children: unknown[] }[] =>
          nodes.map((node) => ({
            name: node.name,
            globalAssetId: node.globalAssetId ?? '',
            bulkCount: node.bulkCount,
            // Line level — company → line → process → equipment. A group like a process, but the UI shows different buttons
            line: node.line === true,
            children: normalize(node.children),
          }));
        return json(200, {
          entryNode: {
            name: entry.idShort ?? '',
            globalAssetId: (entry as unknown as { globalAssetId?: string }).globalAssetId ?? '',
          },
          children: normalize(hierarchyTree(entry)),
        });
      },
    },
    {
      /**
       * Attaches one piece of equipment to the hierarchy.
       *
       * Can be called in two ways.
       *  ① `sourcePackageId` — pick an equipment file already uploaded to this tool. **Recommended.**
       *     The name and Asset address are read from that file, so no transcription mistakes
       *  ② `name` + `globalAssetId` — to record equipment that has no file yet
       */
      method: 'POST',
      pattern: '/packages/:packageId/hierarchy/nodes',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = bodyObject(request);
        const { submodel } = await findHierarchy(store, packageId);

        let name = String(body['name'] ?? '').trim();
        let globalAssetId = String(body['globalAssetId'] ?? '').trim();
        // Which node to insert under — name path from the entry node. Empty means top level
        const parentPath = Array.isArray(body['parentPath'])
          ? (body['parentPath'] as unknown[]).map(String)
          : [];

        // Group (intermediate node) — creates just a level, no file. Something like "Welding process" inside a company file
        if (body['group'] === true) {
          if (!name) throw new ApiError(400, 'BadRequest', tr('그룹 이름이 비었습니다.'));
          const line = body['line'] === true;
          const iriBase = (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string;
          let grouped;
          try {
            grouped = addChild(submodel as never, { name, group: true, line }, iriBase, parentPath);
          } catch (error) {
            throw new ApiError(400, 'BadRequest', (error as Error).message);
          }
          // Lines use their own IRI, so the term (ConceptDescription) must be in the file (KOSMO-SME-3) — add only if missing
          if (line) {
            const concept = lineConceptDescription(iriBase);
            const concepts = await store.listIdentifiables(packageId, 'ConceptDescription');
            if (!concepts.items.some((item) => String(item.content['id']) === concept['id'])) {
              await store.createIdentifiable(packageId, concept);
            }
          }
          await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), grouped as never);
          return json(201, { name, group: true, line });
        }

        const sourcePackageId = String(body['sourcePackageId'] ?? '').trim();
        if (sourcePackageId) {
          if (sourcePackageId === packageId) {
            throw new ApiError(400, 'BadRequest', tr('자기 자신을 매달 수 없습니다.'));
          }
          // Important: cycle prevention — if A contains B and B contains A, the tree becomes infinite.
          //    Once the hierarchy became recursive (company→process→equipment), this became a mistake people can actually make.
          //    Walk down the hierarchy of the file being inserted and refuse if the current file appears.
          await guardCycle(store, packageId, sourcePackageId);
          const shells = await store.listIdentifiables(sourcePackageId, 'AssetAdministrationShell');
          const shell = shells.items[0];
          if (!shell) throw new ApiError(404, 'NotFound', tr('고른 파일에 AAS가 없습니다.'));
          const content = shell.content as {
            idShort?: string;
            assetInformation?: { globalAssetId?: string };
          };
          name = name || content.idShort || '';
          globalAssetId = globalAssetId || content.assetInformation?.globalAssetId || '';
          if (!globalAssetId) {
            throw new ApiError(
              400,
              'BadRequest',
              tr('고른 파일에 Asset 주소(globalAssetId)가 없습니다 — 그 파일을 먼저 고치십시오.'),
            );
          }
        }

        const bulk = Number(body['bulkCount']);
        let next;
        try {
          next = addChild(
            submodel as never,
            {
              name,
              globalAssetId,
              ...(Number.isFinite(bulk) && bulk > 1 ? { bulkCount: Math.trunc(bulk) } : {}),
            },
            (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
            parentPath,
          );
        } catch (error) {
          throw new ApiError(400, 'BadRequest', (error as Error).message);
        }

        await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), next as never);
        return json(201, { name, globalAssetId });
      },
    },
    {
      /** Detaches attached equipment. Important: remove the relationship too — deleting only one leaves a mismatched file */
      method: 'DELETE',
      pattern: '/packages/:packageId/hierarchy/nodes/:name',
      success: [204],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const name = decodeURIComponent(params['name']!);
        const parentRaw = request.query['parent'];
        const parentPath = parentRaw ? String(parentRaw).split('/').filter(Boolean) : [];
        const { submodel } = await findHierarchy(store, packageId);
        let next;
        try {
          next = removeChild(submodel as never, name, parentPath);
        } catch (error) {
          throw new ApiError(404, 'NotFound', (error as Error).message);
        }
        await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), next as never);
        return { status: 204, headers: {}, body: '' };
      },
    },
    {
      /**
       * Imports a submodel from another package — the substance of spec Phase 3 "IDTA standard template import".
       *
       * We cannot distribute official IDTA template files (license, offline). Instead we **copy from an existing
       * AASX that passed validation** — the approach actually used when building many kinds of equipment, and since
       * that source passed the KOSMO Validator it is, if anything, more reliable than the standard template.
       *
       * Unless both of these are handled together, the file breaks the moment it is imported.
       *   ① id rewrite — different equipment needs a different Submodel id (KOSMO-SM-2)
       *   ② bring ConceptDescriptions along — otherwise KOSMO-SME-3 fails across the board
       */
      method: 'POST',
      pattern: '/packages/:packageId/import-submodel',
      async handle({ request, params }) {
        const targetId = params['packageId']!;
        const body = bodyObject(request);
        const sourcePackageId = String(body['sourcePackageId'] ?? '');
        const submodelId = String(body['submodelId'] ?? '');
        const retarget = body['retarget'] !== false;
        /*
         * Important: when a submodel with the same idShort already exists. Previously, a different version meant a different id,
         *    so a second DigitalNameplate silently appeared (observed in an expert demo) — with two of the same name in one AAS,
         *    neither Package Explorer nor KOSMO decides which one to look at.
         *    Default is to refuse (409); the UI asks the person to choose replace or keep alongside.
         */
        const onDuplicate = String(body['onDuplicate'] ?? 'reject') as 'reject' | 'replace' | 'alongside';

        const target = await store.getPackage(targetId);
        if (!target) throw new ApiError(404, 'NotFound', tr('가져올 대상 패키지가 없습니다.'));
        const source = await store.getIdentifiable(sourcePackageId, 'Submodel', submodelId);
        if (!source) throw new ApiError(404, 'NotFound', tr('원본 Submodel을 찾을 수 없습니다.'));

        const content = JSON.parse(JSON.stringify(source.content)) as Record<string, unknown>;
        const oldId = String(content['id']);

        const existing = await store.listIdentifiables(targetId, 'Submodel', { limit: 200 });
        const takenNames = new Set(existing.items.map((item) => item.idShort).filter((n): n is string => !!n));
        const sameName = existing.items.filter(
          (item) => item.idShort !== undefined && item.idShort === content['idShort'],
        );
        if (sameName.length > 0) {
          if (onDuplicate === 'reject') {
            throw new ApiError(
              409,
              'Conflict',
              fill(tr('이미 「{0}」 서브모델이 있습니다. 바꾸거나 나란히 둘지 정해 주십시오.'), { 0: String(content['idShort']) }),
            );
          }
          if (onDuplicate === 'alongside') {
            const base = String(content['idShort']);
            let n = 2;
            while (takenNames.has(`${base}_${n}`)) n += 1;
            content['idShort'] = `${base}_${n}`;
          }
        }

        if (retarget) {
          const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
          const assetName = shells.items[0]?.idShort;
          const idShort = typeof content['idShort'] === 'string' ? content['idShort'] : undefined;
          if (!assetName || !idShort) {
            throw new ApiError(
              400,
              'BadRequest',
              tr('가져오는 쪽 AAS의 idShort와 원본 Submodel의 idShort가 모두 있어야 id를 다시 지을 수 있습니다.'),
            );
          }
          const admin = content['administration'] as { version?: string; revision?: string } | undefined;
          const version = admin?.version ?? '1';
          const revision = admin?.revision ?? '0';
          const newId = `${DEFAULT_POLICY.iriBase}/sm/${assetName}/${idShort}/${version}/${revision}`;
          content['id'] = newId;
          content['administration'] = { ...(admin ?? {}), version, revision };
          // If the source used its own id as semanticId, follow the new id (KOSMO-SM-3).
          // If it pointed to an external IRI, leave it — that needs judgment, so it is left to the linter
          if (firstKeyValue(content['semanticId']) === oldId) {
            content['semanticId'] = {
              type: 'ExternalReference',
              keys: [{ type: 'GlobalReference', value: newId }],
            };
          }
        }

        const newId = String(content['id']);

        // Replace — delete the old one with the same name (and its AAS reference) and insert the new one
        // Important: keep the position (2026-09-07 field validation): delete-then-insert puts it last, so DigitalNameplate dropped
        //    to the end of the tree — the order of the 4 required submodels looks broken. Remember the old position (ordinal) and
        //    AAS reference index and insert the new one **in that spot**. New-file scaffold → import from another file is exactly this case
        const replaced: string[] = [];
        let seatOrdinal: number | undefined;
        let seatRefIndex: number | undefined;
        if (sameName.length > 0 && onDuplicate === 'replace') {
          seatOrdinal = Math.min(...sameName.map((old) => old.ordinal));
          for (const old of sameName) {
            await store.deleteIdentifiable(targetId, 'Submodel', old.id);
            replaced.push(old.id);
          }
          const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
          for (const shell of shells.items) {
            const shellContent = JSON.parse(JSON.stringify(shell.content)) as {
              submodels?: { keys?: { value: string }[] }[];
            };
            const refs = shellContent.submodels ?? [];
            const at = refs.findIndex((ref) => replaced.includes(ref.keys?.[0]?.value ?? ''));
            if (at >= 0 && seatRefIndex === undefined) seatRefIndex = at;
            shellContent.submodels = refs.filter((ref) => !replaced.includes(ref.keys?.[0]?.value ?? ''));
            await store.updateIdentifiable(
              targetId,
              'AssetAdministrationShell',
              shell.id,
              shellContent as unknown as Record<string, unknown>,
            );
          }
        }

        if (await store.getIdentifiable(targetId, 'Submodel', newId)) {
          throw new ApiError(409, 'Conflict', fill(tr('이미 같은 id의 Submodel이 있습니다: {0}'), { 0: newId }));
        }
        await store.createIdentifiable(targetId, content, seatOrdinal === undefined ? {} : { ordinal: seatOrdinal });

        // ConceptDescriptions to bring along — without them KOSMO-SME-3 fails across the board
        const wanted = semanticIdsOf(content);
        let copied = 0;
        for (const semantic of wanted) {
          if (await store.getIdentifiable(targetId, 'ConceptDescription', semantic)) continue;
          const cd = await store.getIdentifiable(sourcePackageId, 'ConceptDescription', semantic);
          if (!cd) continue;
          await store.createIdentifiable(targetId, cd.content);
          copied += 1;
        }

        // Also attach to the AAS's submodels[] — at the old reference's position if this was a replace
        const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
        const shell = shells.items[0];
        if (shell) {
          const shellContent = JSON.parse(JSON.stringify(shell.content)) as { submodels?: unknown[] };
          const refs = (shellContent.submodels ??= []);
          const ref = { type: 'ModelReference', keys: [{ type: 'Submodel', value: newId }] };
          if (seatRefIndex !== undefined && seatRefIndex <= refs.length) refs.splice(seatRefIndex, 0, ref);
          else refs.push(ref);
          await store.updateIdentifiable(
            targetId,
            'AssetAdministrationShell',
            shell.id,
            shellContent as unknown as Record<string, unknown>,
          );
        }

        return json(201, {
          submodelId: newId,
          renamedFrom: newId === oldId ? undefined : oldId,
          copiedConceptDescriptions: copied,
          ...(replaced.length > 0 ? { replaced } : {}),
          ...(onDuplicate === 'alongside' && sameName.length > 0 ? { idShort: content['idShort'] } : {}),
        });
      },
    },
    {
      /**
       * Revision list (extension) — used for optimistic locking.
       *
       * Part 2 list responses are the model itself, so there is no place for revisions (adding them would pollute the model).
       * Yet an extra GET per element would add round trips on every edit.
       * So revisions are served separately — the UI sends this value back as If-Match.
       */
      method: 'GET',
      pattern: '/packages/:packageId/revisions',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));

        const out: Record<string, Record<string, number>> = {};
        for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
          const map: Record<string, number> = {};
          let cursor: string | undefined;
          do {
            const page = await store.listIdentifiables(packageId, modelType, {
              limit: 500,
              ...(cursor ? { cursor } : {}),
            });
            for (const item of page.items) map[item.id] = item.revision;
            cursor = page.cursor;
          } while (cursor);
          out[modelType] = map;
        }
        return json(200, { package: record.revision, ...out });
      },
    },
    {
      /** Interfaces described by the AID — what can be collected (M8) */
      method: 'GET',
      pattern: '/packages/:packageId/interfaces',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const environment = await store.getEnvironment(packageId);
        const interfaces = parseAid(environment);
        return json(200, {
          // The source is **the AID inside the file**, not our own mapping (IDTA-02017)
          source: 'AssetInterfacesDescription',
          interfaces,
        });
      },
    },
    {
      /** Query collected values — a time series, not the model (option A) */
      method: 'GET',
      pattern: '/packages/:packageId/values',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const query: Parameters<AasStore['readValues']>[1] = {};
        const interfaceName = request.query['interface'];
        if (interfaceName) query.interfaceName = interfaceName;
        const propertyName = request.query['property'];
        if (propertyName) query.propertyName = propertyName;
        const from = request.query['from'];
        if (from) query.from = from;
        const to = request.query['to'];
        if (to) query.to = to;
        // Range by receive time — tags with constant values are still caught as "values received that day" (daily status bar)
        if (request.query['basis'] === 'received') query.basis = 'received';
        const limit = request.query['limit'];
        if (limit !== undefined) {
          const parsed = Number(limit);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new ApiError(400, 'BadRequest', fill(tr('limit이 양의 정수가 아닙니다: {0}'), { 0: limit }));
          }
          query.limit = parsed;
        }
        const values = await store.readValues(packageId, query);
        return json(200, { result: values });
      },
    },
    {
      /**
       * Collects once (M8). Periodic runs are handled by the collector separately; this route is for **checking right now**.
       * Deployments without an injected adapter answer 501 — some servers are authoring-only.
       */
      method: 'POST',
      pattern: '/packages/:packageId/collect',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!options.openReader) {
          throw new ApiError(
            501,
            'NotImplemented',
            tr('이 서버에는 수집 어댑터가 없습니다. OPC UA 스택을 올린 배포에서 쓰십시오.'),
          );
        }
        const environment = await store.getEnvironment(packageId);
        const interfaces = parseAid(environment);
        if (interfaces.length === 0) {
          throw new ApiError(
            404,
            'NotFound',
            tr('AssetInterfacesDescription 서브모델이 없습니다. 수집할 주소를 알 수 없습니다.'),
          );
        }

        const runner = new CollectionRunner({
          packageId,
          interfaces,
          openReader: options.openReader,
          sink: { append: (samples) => store.appendValues(packageId, samples) },
          intervalMs: 0,
        });
        try {
          return json(200, await runner.runOnce());
        } finally {
          await runner.stop();
        }
      },
    },
    {
      /**
       * Rule and convention catalog — **answers "on what grounds is this a pass?"**
       *
       * Important: extracts **the rules actually running now**, not what the documentation says.
       *    If docs and code diverge, this screen exposes it first.
       */
      method: 'GET',
      pattern: '/rules',
      async handle({ request }) {
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        return json(200, ruleCatalog(overrides));
      },
    },
    {
      /**
       * The conventions must be known even without a file — needed to render "Create new equipment" on the start screen.
       * Knowledge lives in one place only (the linter policy).
       */
      method: 'GET',
      pattern: '/policy',
      async handle() {
        return json(200, { ...DEFAULT_POLICY, ...options.policy });
      },
    },
    {
      /**
       * UML diagram (SVG) to attach to the guidance document.
       *
       * KTL regulation §13, note 3 requires **a UML diagram attached for every submodel**.
       * Important: the tool draws only facts present in the file — people write the document prose.
       * Without `?submodel=`, the overall AAS structure diagram.
       */
      method: 'GET',
      pattern: '/packages/:packageId/diagram.svg',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const wanted = request.query['submodel'];
        const fontSize = Number(request.query['fontSize']);
        const options = Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {};

        let svg: string;
        if (wanted === undefined || wanted === '') {
          svg = overviewUml(pkg.environment, options);
        } else {
          const submodel = (pkg.environment.submodels ?? []).find(
            (item) => item.idShort === wanted || item.id === wanted,
          );
          if (!submodel) throw new ApiError(404, 'NotFound', fill(tr('서브모델을 찾을 수 없습니다: {0}'), { 0: wanted }));
          svg = submodelUml(submodel, options);
        }
        return {
          status: 200,
          headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
          body: new TextEncoder().encode(svg),
        };
      },
    },
    {
      /**
       * Submodel element detail table — a guidance appendix (regulation §13, note 5).
       *
       * Important: some submodels **must not get a table.** For IDTA standard templates the regulation says "omit the table" —
       *    in that case, return the information to state instead and the items a person must fill in.
       * `format=html` (for pasting) · `csv` (Excel) · default JSON (for the UI).
       */
      method: 'GET',
      pattern: '/packages/:packageId/table',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const wanted = request.query['submodel'];
        if (!wanted) throw new ApiError(400, 'BadRequest', tr('submodel을 지정하십시오.'));
        const submodel = (pkg.environment.submodels ?? []).find(
          (item) => item.idShort === wanted || item.id === wanted,
        );
        if (!submodel) throw new ApiError(404, 'NotFound', fill(tr('서브모델을 찾을 수 없습니다: {0}'), { 0: wanted }));

        const plan = planFor(submodel);
        const format = request.query['format'];

        if (plan.kind === 'info') {
          const info = submodelInfo(submodel);
          if (format === 'html' || format === 'csv') {
            throw new ApiError(
              409,
              'Conflict',
              fill(tr('{0}은(는) 표를 만들지 않습니다. {1}'), { 0: plan.idShort, 1: plan.reason }),
            );
          }
          return json(200, { plan, info });
        }

        const rows = submodelTable(pkg.environment, submodel);
        const tables = submodelTables(pkg.environment, submodel);
        if (format === 'html') {
          // Important: what the UI shows and what goes into the document **must be the same** — use the same HTML
          // Table numbers must continue across the whole document — accept a starting value
          const from = Number(request.query['from']);
          return {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(
              submodelTablesHtml(tables, {
                submodelName: plan.idShort,
                ...(Number.isFinite(from) && from > 0 ? { from } : {}),
              }),
            ),
          };
        }
        if (format === 'csv') {
          return {
            status: 200,
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="table.csv"; filename*=UTF-8''${encodeURIComponent(`${plan.idShort}.csv`)}`,
            },
            body: new TextEncoder().encode(tableCsv(rows)),
          };
        }
        return json(200, { plan, rows, tables, tableCount: tables.length });
      },
    },
    {
      /** At a glance, what material each submodel needs (a table or information) */
      method: 'GET',
      pattern: '/packages/:packageId/doc-plan',
      async handle({ params }) {
        const pkg = await snapshot(store, params['packageId']!);
        return json(200, {
          result: (pkg.environment.submodels ?? []).map((submodel) => planFor(submodel)),
        });
      },
    },
    {
      /**
       * Browses a device to fetch its tag list — so nobody has to type NodeIds by hand.
       *
       * Important: not tied to a file. It is used **before** an AID exists, so there is no packageId.
       * Important: read-only. Nothing is written to the device.
       */
      method: 'POST',
      pattern: '/opcua/browse',
      success: [200],
      async handle({ request }) {
        if (!options.browseDevice) {
          throw new ApiError(501, 'NotImplemented', tr('이 배포에는 수집 어댑터가 없습니다.'));
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const endpoint = String(body['endpoint'] ?? '').trim();
        if (!/^opc\.tcp:\/\/.+/.test(endpoint)) {
          throw new ApiError(400, 'BadRequest', fill(tr('접속 주소는 opc.tcp:// 로 시작해야 합니다: {0}'), { 0: endpoint }));
        }
        try {
          return json(200, await options.browseDevice(endpoint));
        } catch (error) {
          /*
           * Important: pointing at itself (or the same tool) is **blocked.** A warning is not enough:
           *    creating from it makes `createMissing` add dozens of elements and dozens of CDs to the model,
           *    while "Delete connection" removes only the AID — there is no way back.
           */
          // Important: do not use `instanceof` — this file must not know the protocol (browseDevice injection principle).
          //    Check by name: @aas/opcua's SelfBrowseError uses this name.
          if (error instanceof Error && error.name === 'OutboundBlockedError') {
            throw new ApiError(403, 'Forbidden', error.message);
          }
          if (error instanceof Error && error.name === 'SelfBrowseError') {
            throw new ApiError(409, 'Conflict', error.message);
          }
          // Failing to connect is not our fault — pass the reason through as is
          throw new ApiError(
            502,
            'BadGateway',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      /**
       * Create a collection connection (AID).
       *
       * The AID structure is nested 4–5 levels deep, so people cannot build it with "Add element" — here we take just the endpoint
       * and tag list and build it per the IDTA-02017 spec, standard semanticIds included.
       *
       * Important: an existing AID is **replaced**. One collection connection per device is normal;
       *    if two pile up, there is no telling which one is right.
       */
      method: 'POST',
      pattern: '/packages/:packageId/aid',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = (request.body ?? {}) as Record<string, unknown>;

        const shells = await store.listIdentifiables(packageId, 'AssetAdministrationShell');
        const shell = shells.items[0];
        if (!shell?.idShort) {
          throw new ApiError(400, 'BadRequest', tr('AAS의 idShort(장비명)가 있어야 AID id를 지을 수 있습니다.'));
        }

        let submodel: Record<string, unknown>;
        try {
          submodel = buildAidSubmodel({
            assetName: shell.idShort,
            iriBase: (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
            endpoint: String(body['endpoint'] ?? ''),
            title: typeof body['title'] === 'string' ? body['title'] : undefined,
            tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
          } as never);
        } catch (error) {
          if (error instanceof AidBuildError) throw new ApiError(400, 'BadRequest', error.message);
          throw error;
        }

        const newId = String(submodel['id']);
        // Important: add CDs for our own IRI terms too — otherwise the file is born with 13 KOSMO-SME-3 findings
        //    the moment it is created (observed in an expert demo). Existing ids are skipped
        for (const concept of aidConceptDescriptions({
          assetName: String(shell.idShort),
          iriBase: (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
          endpoint: String(body['endpoint'] ?? ''),
          tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
        } as never)) {
          const cid = String(concept['id']);
          const already = await store.getIdentifiable(packageId, 'ConceptDescription', cid);
          if (!already) await store.createIdentifiable(packageId, concept);
        }
        const existing = await store.getIdentifiable(packageId, 'Submodel', newId);
        if (existing) {
          await store.updateIdentifiable(packageId, 'Submodel', newId, submodel);
        } else {
          await store.createIdentifiable(packageId, submodel);
          // Also attach to the AAS's submodels[] — otherwise it becomes a submodel attached to nothing
          const shellContent = JSON.parse(JSON.stringify(shell.content)) as { submodels?: unknown[] };
          (shellContent.submodels ??= []).push({
            type: 'ModelReference',
            keys: [{ type: 'Submodel', value: newId }],
          });
          await store.updateIdentifiable(
            packageId,
            'AssetAdministrationShell',
            shell.id,
            shellContent as unknown as Record<string, unknown>,
          );
        }

        /*
         * Important: **the other half** of a collection connection — create the places in the model where tag values land.
         *
         * With only the AID, collection works, but if the model lacks a matching idShort the values go out neither via the
         * standard API (live) nor via OPC UA exposure. Until now that was only reported as a warning —
         * with dozens of tags the user had to build them all by hand in the tree, which amounted to giving up.
         *
         * Placement follows the KTL rule: OperationalData > category > subcategory > Property.
         * Created **only when the request explicitly sets** `createMissing` — never silently grow someone's model.
         */
        const createMissing = body['createMissing'] as
          | { group?: unknown; subgroup?: unknown }
          | undefined;
        let elementsAdded: string[] = [];
        /** Names not created because they already exist in another submodel — the user needs to know */
        let elementsConflicted: string[] = [];
        if (createMissing) {
          const iriBase = (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string;
          let target = (await store.listIdentifiables(packageId, 'Submodel')).items.find(
            (item) => item.idShort === 'OperationalData',
          );
          /*
           * Important: create it if missing. OperationalData is **a KOSMO-required submodel** (policy.requiredSubmodels),
           *    so its absence is already a violation. Refusing with 400 here would make the main action
           *    "Create collection connection" fail entirely because of one add-on — that is worse.
           */
          if (!target) {
            const smId = `${iriBase}/sm/${shell.idShort}/OperationalData/1/0`;
            const created = await store.createIdentifiable(packageId, {
              modelType: 'Submodel',
              id: smId,
              idShort: 'OperationalData',
              kind: 'Template',
              administration: { version: '1', revision: '0' },
              semanticId: {
                type: 'ExternalReference',
                keys: [{ type: 'GlobalReference', value: smId }],
              },
              // Important: do not leave submodelElements empty — the V3.0 schema rejects empty arrays.
              //    The merge right below fills it
            });
            const shellNow = await store.getIdentifiable(
              packageId,
              'AssetAdministrationShell',
              shell.id,
            );
            const content = JSON.parse(JSON.stringify(shellNow?.content ?? shell.content)) as {
              submodels?: unknown[];
            };
            (content.submodels ??= []).push({
              type: 'ModelReference',
              keys: [{ type: 'Submodel', value: smId }],
            });
            await store.updateIdentifiable(
              packageId,
              'AssetAdministrationShell',
              shell.id,
              content as unknown as Record<string, unknown>,
            );
            target = created;
          }
          /*
           * Important: collect names that can receive values across **the whole file** and pass them in. Looking only inside
           *    the target submodel would create a name like DigitalNameplate's `SerialNumber` here again,
           *    and then collected values cannot tell where to land, so **neither** gets them (observed).
           *    `valuedNames` decides — it must use the same rule as the overlay so the two don't diverge.
           */
          const takenNames = valuedNames(await store.getEnvironment(packageId), target.id);

          try {
            const merged = mergeRuntimeGroup(target.content, {
              iriBase,
              takenNames,
              group: String(createMissing.group ?? 'ProcessMonitoring'),
              subgroup: String(createMissing.subgroup ?? 'CollectedValues'),
              tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
            });
            if (merged.added.length > 0) {
              for (const concept of merged.conceptDescriptions) {
                const cid = String(concept['id']);
                const already = await store.getIdentifiable(packageId, 'ConceptDescription', cid);
                if (!already) {
                  await store.createIdentifiable(packageId, concept);
                  continue;
                }
                /*
                 * Important: one CD is **shared** by the AID and the model (same tag name = same cd/{name}).
                 *    The AID side creates it first as STRING, but if the model Property is xs:double
                 *    it trips KOSMO-SME-5 (observed). The side that knows the data type is **the Property** —
                 *    that AID element is an SMC, not subject to SME-5, so changing it is harmless.
                 *    Only touch CDs with our own IRI.
                 */
                if (!cid.startsWith(iriBase)) continue;
                await store.updateIdentifiable(packageId, 'ConceptDescription', cid, {
                  ...already.content,
                  embeddedDataSpecifications: concept['embeddedDataSpecifications'],
                });
              }
              await store.updateIdentifiable(packageId, 'Submodel', target.id, merged.submodel);
            }
            elementsAdded = merged.added;
            elementsConflicted = merged.conflicts;
          } catch (error) {
            if (error instanceof RuntimeBuildError)
              throw new ApiError(400, 'BadRequest', error.message);
            throw error;
          }
        }

        // Report right after creation: do tag names match model elements (a condition for live export)
        const environment = await store.getEnvironment(packageId);
        const overlay = overlayEnvironment(
          environment,
          (Array.isArray(body['tags']) ? (body['tags'] as { name: string }[]) : []).map((tag) => ({
            packageId,
            interfaceName: 'InterfaceTemplateForOPCUA',
            propertyName: tag.name,
            observedAt: new Date().toISOString(),
            valueText: '',
          })),
        );

        return json(201, {
          submodelId: newId,
          replaced: existing !== null && existing !== undefined,
          nameMatches: overlay.notes.filter((note) => note.outcome === 'applied').length,
          nameMisses: overlay.notes
            .filter((note) => note.outcome !== 'applied')
            .map((note) => note.propertyName),
          /** Elements newly created via createMissing */
          elementsAdded,
          /** Ones not created because the same name exists in another submodel */
          elementsConflicted,
        });
      },
    },
    {
      /**
       * Which model element each collected value lands on — **connection health check**.
       *
       * Important: without this, there is no way to tell why values don't change when reading with `live=true`.
       *    Observed case: the demo file's AID collects `MotorSpeed`, but the model has no such name
       *    (the model has `CurrentLineSpeed`). **Values land only when the AID name matches the element idShort.**
       */
      method: 'GET',
      pattern: '/packages/:packageId/live',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const pkg = await snapshot(store, packageId);
        const samples = await store.readValues(packageId, { limit: 500 });
        const result = overlayEnvironment(pkg.environment, samples);
        return json(200, {
          collected: latestByProperty(samples).size,
          applied: result.applied,
          notes: result.notes,
        });
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/policy',
      async handle({ params }) {
        const record = await store.getPackage(params['packageId']!);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        // Used by the authoring UI when creating new ids. Copying conventions (iriBase etc.) into the UI
        // would give the linter and UI different rules — knowledge lives in one place only
        return json(200, { ...DEFAULT_POLICY, ...options.policy });
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/lint',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const result = lint(pkg.environment, ALL_RULES, {
          package: pkg.opc,
          ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
        });
        const detail = request.query['detail'] === 'true';
        return json(200, {
          ...lintSummary(result),
          findings: detail
            ? result.findings
            : result.findings.filter((f: Finding) => f.severity === 'error'),
        });
      },
    },
    {
      /** Validation report — open in a browser and print as is to get a PDF (spec Phase 3 deliverable) */
      method: 'GET',
      pattern: '/packages/:packageId/report',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const pkg = await snapshot(store, packageId);
        // Important: must judge with the same policy as /lint. Once only this route was pinned to DEFAULT_POLICY,
        //    so the UI showed 10 violations while the report printed a pass (found in the 2026-09-03 review).
        //    The report is a submission attachment, so if it differs from the UI, neither can be trusted
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const policy = { ...DEFAULT_POLICY, ...overrides };
        const result = lint(pkg.environment, ALL_RULES, {
          package: pkg.opc,
          ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
        });
        const html = formatHtmlReport(result, {
          title: record.name,
          generatedAt: localTimestamp(new Date()),
          policy,
          relocations: await readLedger(store, packageId),
        });
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: new TextEncoder().encode(html),
        };
      },
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/fix',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const includeWarnings = request.query['includeWarnings'] === '1' || request.query['includeWarnings'] === 'true';
        const body = (request.body ?? {}) as { select?: unknown };
        const select = Array.isArray(body.select)
          ? (body.select as unknown[]).filter(
              (s): s is FixSelector =>
                typeof s === 'object' && s !== null && typeof (s as FixSelector).ruleId === 'string' && typeof (s as FixSelector).pointer === 'string',
            )
          : undefined;
        const { result, counts, ledger } = await fixOne(store, packageId, overrides, includeWarnings, select);
        return json(200, {
          applied: result.applied,
          skipped: result.skipped,
          relocations: result.relocations,
          ledger,
          rounds: result.rounds,
          before: lintSummary(result.before),
          after: lintSummary(result.after),
          store: counts,
        });
      },
    },
    {
      /** Fix preview — does not save. The UI popup shows per-item before/after and sends only the checked ones to POST /fix */
      method: 'GET',
      pattern: '/packages/:packageId/fix-preview',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const includeWarnings = request.query['includeWarnings'] === '1' || request.query['includeWarnings'] === 'true';
        const result = await previewFix(store, packageId, overrides, includeWarnings);
        return json(200, {
          applied: result.applied,
          skipped: result.skipped,
          relocations: result.relocations,
          rounds: result.rounds,
          before: lintSummary(result.before),
          after: lintSummary(result.after),
        });
      },
    },
    {
      /** IRI relocation ledger — new IRI → original IRI */
      method: 'GET',
      pattern: '/packages/:packageId/relocations',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        return json(200, { relocations: await readLedger(store, packageId) });
      },
    },
    {
      /**
       * Revert to original IRIs — for when a rule interpretation is reversed. body `{ iris?: string[] }`; all if omitted.
       * After reverting, a KOSMO-first policy flags them as violations again — that is correct (the user decides by changing the policy)
       */
      method: 'POST',
      pattern: '/packages/:packageId/relocations/revert',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const ledger = await readLedger(store, packageId);
        const body = (request.body ?? {}) as { iris?: unknown };
        const only = Array.isArray(body.iris) ? (body.iris as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
        const pkg = await snapshot(store, packageId);
        const outcome = revertRelocations(pkg.environment, ledger, only);
        const counts = await writeBackEnvironment(store, packageId, outcome.environment);
        await writeLedger(store, packageId, outcome.remaining);
        return json(200, { reverted: outcome.reverted, remaining: outcome.remaining, store: counts });
      },
    },
  ];
}
